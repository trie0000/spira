// Ticket properties modal — Teams スレッド設定の編集が主目的。
//
// 機能:
//   - 内部スレッド / 外部スレッドの「解除」(リンク情報をクリア)
//   - Teams メッセージ URL を貼り付けて手動でスレッド紐付け
//
// レイアウト方針: 「履歴を追加」モーダルと統一感を出すため、
// 2 列グリッド (ラベル右寄せ + 値) を使用。セクションヘッダは
// grid-column: 1 / -1 で全幅にする。

import { el } from '../utils/dom';
import { openModal, confirmModal } from '../components/modal';
import { toast } from '../components/toast';
import { getRepo } from '../api/repo';
import { setState } from '../state';
import type { Ticket } from '../types';

interface ParsedTeamsUrl {
  channelId: string;
  messageId: string;
  url: string;
}

/** Teams メッセージ URL からチャネル ID / メッセージ ID を抽出する。
 *  対応形式:
 *    https://teams.microsoft.com/l/message/<channelId>/<messageId>?...
 *    https://teams.microsoft.com/dl/launcher/launcher.html?url=...&...  ← 2 段デコード
 *  失敗時は null。 */
/** B3: Teams DeepLink URL の host を厳密検証。
 *  URL() でパースし hostname が teams.microsoft.com (または末尾一致のサブ
 *  ドメイン *.teams.microsoft.com) であることを確認する。文字列途中マッチで
 *  攻撃者由来の https://attacker.example/redir?u=teams.microsoft.com/... を
 *  許してしまうのを防ぐ。 */
function isTeamsHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === 'teams.microsoft.com' || h.endsWith('.teams.microsoft.com');
}

function parseTeamsMessageUrl(input: string): ParsedTeamsUrl | null {
  const raw = input.trim();
  if (!raw) return null;
  // 必ず URL() でパースして host を検証。失敗なら拒否。
  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  if (!isTeamsHost(u.hostname)) return null;

  // launcher ラッパ (https://teams.microsoft.com/dl/launcher/launcher.html?url=...)
  if (u.pathname.includes('/dl/launcher/')) {
    const inner = u.searchParams.get('url');
    if (inner) return parseTeamsMessageUrl(decodeURIComponent(inner));
  }

  // 期待するパス形: /l/message/<channelId>/<messageId> または /_#/l/message/...
  const path = u.pathname;
  const m = path.match(/^\/(?:_#\/)?l\/message\/([^/?#]+)\/([^/?#]+)/);
  if (!m) return null;
  const channelId = decodeURIComponent(m[1]!);
  const messageId = decodeURIComponent(m[2]!);
  // URL は正規化したものを使う (raw を直接持つと余分なクエリが残る)
  return { channelId, messageId, url: u.toString() };
}

// 履歴を追加モーダルと揃えたスタイル定義 ----------------------------------
const LABEL_STYLE =
  'color:var(--ink-3);font-size:var(--fs-sm);' +
  'align-self:center;justify-self:end;text-align:right;white-space:nowrap';
const LABEL_TOP_STYLE = LABEL_STYLE + ';align-self:start;padding-top:8px';
const SECTION_HEAD_STYLE =
  'grid-column:1 / -1;' +
  'font-size:var(--fs-md);font-weight:600;color:var(--ink);' +
  'border-top:1px solid var(--line);padding-top:var(--s-3);margin-top:var(--s-2)';
const VALUE_STYLE = 'min-width:0;word-break:break-word';
const CODE_STYLE =
  'font-family:ui-monospace,Menlo,monospace;font-size:12px;' +
  'background:var(--paper-2);padding:2px 6px;border-radius:3px;' +
  'word-break:break-all;display:inline-block;max-width:100%';

/** 1 スレッド分の rows を grid に流し込む。
 *  「履歴を追加」と同じ 2 列グリッドの中に、ラベル+値ペアを追加する。 */
function appendThreadRows(
  grid: HTMLElement,
  ticket: Ticket,
  threadType: 'internal' | 'user',
  onChanged: (patch: Partial<Ticket>) => Promise<void>,
): void {
  const isInternal = threadType === 'internal';
  const sectionLabel = isInternal ? '🏢 内部スレッド' : '👥 外部スレッド';
  const deepLink = isInternal ? ticket.internalDeepLink : ticket.userDeepLink;
  const channelId = isInternal ? ticket.internalChannelId : ticket.userChannelId;
  const messageId = isInternal ? ticket.internalThreadId : ticket.userThreadId;

  // セクションヘッダ (全幅)
  grid.append(el('div', { style: SECTION_HEAD_STYLE }, [sectionLabel]));

  // 状態
  const statusValue = deepLink
    ? el('span', { style: 'color:rgb(34,197,94);font-weight:500' }, ['● 紐付け済み'])
    : el('span', { style: 'color:var(--ink-3)' }, ['○ 未紐付け']);
  grid.append(el('label', { style: LABEL_STYLE }, ['状態']), statusValue);

  // 紐付け済みのとき → DeepLink / Channel ID / Message ID を表示
  if (deepLink) {
    grid.append(
      el('label', { style: LABEL_STYLE }, ['DeepLink']),
      el('div', { style: VALUE_STYLE }, [
        el('a', {
          href: deepLink, target: '_blank', rel: 'noopener',
          style: 'color:var(--accent);text-decoration:none;word-break:break-all;font-size:12px',
        }, [deepLink]),
      ]),
      el('label', { style: LABEL_STYLE }, ['Channel ID']),
      el('div', { style: VALUE_STYLE }, [el('code', { style: CODE_STYLE }, [channelId ?? '(なし)'])]),
      el('label', { style: LABEL_STYLE }, ['Message ID']),
      el('div', { style: VALUE_STYLE }, [el('code', { style: CODE_STYLE }, [messageId ?? '(なし)'])]),
    );
  }

  // 操作: 解除ボタン
  const clearBtn = el('button', {
    type: 'button',
    class: 'spira-btn spira-btn--ghost spira-btn--sm',
    disabled: !deepLink,
    onclick: () => {
      const root = document.querySelector<HTMLElement>('#spira-root') ?? document.body;
      confirmModal(root, {
        title: `${sectionLabel}の紐付けを解除`,
        message: 'Spira 側のリンク情報のみを削除します。Teams のメッセージ自体は残ります。\n\n解除後は「起票」ボタンで新規スレッドを作るか、URL を貼り付けて再紐付けできます。',
        primaryLabel: '解除',
        primaryVariant: 'danger',
        onConfirm: async () => {
          const patch: Partial<Ticket> = isInternal
            ? { internalDeepLink: undefined, internalChannelId: undefined, internalThreadId: undefined }
            : { userDeepLink: undefined, userChannelId: undefined, userThreadId: undefined };
          await onChanged(patch);
        },
      });
    },
  }, ['🔓 紐付けを解除']);
  grid.append(el('label', { style: LABEL_STYLE }, ['操作']), el('div', {}, [clearBtn]));

  // URL ペースト入力 (paste 即時反映)
  const urlInput = el('input', {
    type: 'url',
    placeholder: 'Teams メッセージの「リンクをコピー」した URL を貼り付け',
    style:
      'width:100%;padding:var(--s-2) var(--s-3);' +
      'border:1px solid var(--line);border-radius:var(--r-2);' +
      'font-size:12px;font-family:ui-monospace,Menlo,monospace;' +
      'background:var(--paper);color:var(--ink)',
  }) as HTMLInputElement;

  const parseInfo = el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3)' });

  let applying = false;
  const tryApply = async (raw: string): Promise<void> => {
    if (applying) return;
    parseInfo.replaceChildren();
    if (raw.trim() === '') return;
    const parsed = parseTeamsMessageUrl(raw);
    if (!parsed) {
      parseInfo.append(
        el('div', { style: 'color:rgb(239,68,68);padding-top:4px' }, [
          '⚠ Teams メッセージ URL を解析できませんでした',
        ]),
      );
      return;
    }
    parseInfo.append(
      el('div', { style: 'color:rgb(34,197,94);padding-top:4px' }, [
        `🔗 解析 OK: ${parsed.channelId} / ${parsed.messageId} — 自動紐付け中…`,
      ]),
    );
    applying = true;
    try {
      const patch: Partial<Ticket> = isInternal
        ? { internalDeepLink: parsed.url, internalChannelId: parsed.channelId, internalThreadId: parsed.messageId }
        : { userDeepLink: parsed.url, userChannelId: parsed.channelId, userThreadId: parsed.messageId };
      await onChanged(patch);
    } finally {
      applying = false;
    }
  };

  urlInput.addEventListener('paste', (e: ClipboardEvent) => {
    const text = e.clipboardData?.getData('text') ?? '';
    if (!text) return;
    setTimeout(() => { tryApply(text); }, 0);
  });
  urlInput.addEventListener('input', () => {
    const v = urlInput.value;
    if (v.length > 40 && /teams\.microsoft\.com/.test(v)) {
      tryApply(v);
    } else {
      parseInfo.replaceChildren();
    }
  });

  grid.append(
    el('label', { style: LABEL_TOP_STYLE }, ['URL を貼付']),
    el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-2);min-width:0' }, [
      urlInput,
      parseInfo,
    ]),
  );
}

/** チケットプロパティモーダルを開く。
 *  Teams スレッド設定の解除・手動紐付けがメイン。 */
export function openTicketPropertiesModal(ticket: Ticket): void {
  const root = document.querySelector<HTMLElement>('#spira-root') ?? document.body;

  // 現在のチケット状態 (Teams 紐付け変更で更新される)
  let current = { ...ticket };

  // 2 列グリッド本体。再描画は中身を replaceChildren で差し替える。
  const grid = el('div', {
    style:
      'display:grid;grid-template-columns:96px minmax(0,1fr);' +
      'gap:var(--s-3) var(--s-4);align-items:center',
  });

  const applyPatch = async (patch: Partial<Ticket>): Promise<void> => {
    try {
      const updated = await getRepo().updateTicket(current.id, patch);
      if (updated) current = updated;
      else current = { ...current, ...patch };
      renderGrid();
      setState({});
      toast(root, '更新しました', 'ok', 3000);
    } catch (e) {
      toast(root, `更新失敗: ${(e as Error).message}`, 'error');
    }
  };

  const renderGrid = (): void => {
    grid.replaceChildren();

    // 基本情報 (読取)
    grid.append(
      el('label', { style: LABEL_STYLE }, ['#ID']),
      el('div', { style: VALUE_STYLE }, [String(current.id)]),
      el('label', { style: LABEL_STYLE }, ['件名']),
      el('div', { style: VALUE_STYLE }, [current.title || '(未設定)']),
      el('label', { style: LABEL_STYLE }, ['ステータス']),
      el('div', { style: VALUE_STYLE }, [current.status]),
      el('label', { style: LABEL_STYLE }, ['優先度']),
      el('div', { style: VALUE_STYLE }, [current.priority]),
    );

    // ソース (編集可能)
    const sourceSel = el('select', {
      class: 'spira-input',
      style: 'width:200px',
      onchange: () => {
        const v = (sourceSel as HTMLSelectElement).value;
        const next = (v === '' ? undefined : v) as Ticket['source'];
        void applyPatch({ source: next });
      },
    }, [
      el('option', { value: '', ...(!current.source ? { selected: 'selected' } : {}) }, ['(未設定)']),
      el('option', { value: 'mail',  ...(current.source === 'mail'  ? { selected: 'selected' } : {}) }, ['📧 メール']),
      el('option', { value: 'forms', ...(current.source === 'forms' ? { selected: 'selected' } : {}) }, ['📋 Forms']),
      el('option', { value: 'teams', ...(current.source === 'teams' ? { selected: 'selected' } : {}) }, ['💬 Teams']),
      el('option', { value: 'other', ...(current.source === 'other' ? { selected: 'selected' } : {}) }, ['📝 その他']),
    ]) as HTMLSelectElement;
    grid.append(
      el('label', { style: LABEL_STYLE }, ['ソース']),
      sourceSel,
    );

    // 内部スレッド / 外部スレッド
    appendThreadRows(grid, current, 'internal', applyPatch);
    appendThreadRows(grid, current, 'user', applyPatch);

    // フッターヒント (全幅)
    grid.append(
      el('div', {
        style:
          'grid-column:1 / -1;' +
          'font-size:var(--fs-xs);color:var(--ink-3);' +
          'background:var(--paper-2);padding:var(--s-3);' +
          'border-radius:var(--r-2);line-height:1.6;margin-top:var(--s-2)',
      }, [
        '※ ステータス・優先度・担当者・期限はチケット詳細のヘッダから直接編集できます。',
        el('br'),
        '※ Teams スレッド「解除」は Spira 側のリンク情報のみ削除し、Teams 上のメッセージは残ります。',
        el('br'),
        '※ Teams で対象メッセージの「···」→「リンクをコピー」した URL を貼ると自動で紐付け。',
      ]),
    );
  };

  renderGrid();

  openModal(root, {
    title: 'チケットプロパティ',
    body: grid,
    size: 'lg',
    primaryLabel: '閉じる',
    hideCancel: true,
    onPrimary: () => { /* close only */ },
  });
}
