// 監査ログビューア。設定メニューから開く。
// フィルタ: 期間 / アクション種別 / 対象チケット / 実行ユーザ。
// テーブル表示 + Details 列 (JSON 展開) + 取得件数表示。

import { el } from '../utils/dom';
import { icon } from '../icons';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { getRepo } from '../api/repo';
import { AUDIT_ACTION_LABEL, getRetentionDays, setRetentionDays, getRetentionMinMax } from '../lib/audit';
import type { AuditAction, AuditRecord } from '../types';

function getRoot(): HTMLElement {
  return (document.querySelector<HTMLElement>('#spira-root') ?? document.body);
}

const LABEL_STYLE =
  'color:var(--ink-3);font-size:var(--fs-sm);' +
  'align-self:center;justify-self:end;text-align:right;white-space:nowrap';

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export async function openAuditLogModal(): Promise<void> {
  const root = getRoot();

  // ── Filter UI ────────────────────────────────────────────────────
  const fromInput = el('input', {
    type: 'date',
    class: 'spira-input',
    style: 'width:160px',
  }) as HTMLInputElement;
  const toInput = el('input', {
    type: 'date',
    class: 'spira-input',
    style: 'width:160px',
  }) as HTMLInputElement;
  const actionSel = el('select', { class: 'spira-input', style: 'width:200px' }, [
    el('option', { value: '' }, ['(すべて)']),
    ...((Object.keys(AUDIT_ACTION_LABEL) as AuditAction[]).map(a =>
      el('option', { value: a }, [`${AUDIT_ACTION_LABEL[a]} (${a})`]),
    )),
  ]) as HTMLSelectElement;
  const ticketInput = el('input', {
    type: 'number',
    class: 'spira-input',
    style: 'width:120px',
    placeholder: '#',
    min: '0',
  }) as HTMLInputElement;
  const actorInput = el('input', {
    type: 'email',
    class: 'spira-input',
    style: 'width:220px',
    placeholder: 'user@example.com',
    autocomplete: 'off',
  }) as HTMLInputElement;
  const limitSel = el('select', { class: 'spira-input', style: 'width:100px' }, [
    el('option', { value: '100' }, ['100']),
    el('option', { value: '500', selected: 'selected' }, ['500']),
    el('option', { value: '1000' }, ['1000']),
    el('option', { value: '2000' }, ['2000']),
  ]) as HTMLSelectElement;

  // デフォルト: 直近 7 日
  const today = new Date();
  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);
  fromInput.value = weekAgo.toISOString().slice(0, 10);
  toInput.value = today.toISOString().slice(0, 10);

  // 検索ボタン
  const searchBtn = el('button', {
    type: 'button',
    class: 'spira-btn spira-btn--primary spira-btn--sm',
    onclick: () => void runSearch(),
  }, [
    el('span', { html: icon('search'), style: 'display:inline-flex;width:14px;height:14px' }),
    '検索',
  ]);

  // CSV エクスポートボタン
  const csvBtn = el('button', {
    type: 'button',
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    title: '現在表示している結果を CSV で保存',
    onclick: () => exportCsv(),
  }, [
    el('span', { html: icon('external'), style: 'display:inline-flex;width:14px;height:14px' }),
    'CSV',
  ]);

  // 件数表示
  const countLabel = el('span', {
    style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-left:auto',
  }, ['結果: -']);

  // 保持期間設定
  const minMax = getRetentionMinMax();
  const retentionInput = el('input', {
    type: 'number',
    class: 'spira-input',
    style: 'width:80px',
    min: String(minMax.min),
    max: String(minMax.max),
  }) as HTMLInputElement;
  // 現在値を非同期取得
  void getRetentionDays().then((d) => { retentionInput.value = String(d); });
  const retentionSaveBtn = el('button', {
    type: 'button',
    class: 'spira-btn spira-btn--secondary spira-btn--sm',
    onclick: async () => {
      const v = parseInt(retentionInput.value, 10);
      if (!Number.isFinite(v)) { toast(root, '数値を入力してください', 'error'); return; }
      try {
        await setRetentionDays(v);
        toast(root, `保持期間を ${v} 日に設定しました`, 'ok');
      } catch (e) {
        toast(root, `保存失敗: ${(e as Error).message}`, 'error');
      }
    },
  }, ['保存']);

  // ── Result table ─────────────────────────────────────────────────
  const tbody = el('tbody', {});
  let currentResults: AuditRecord[] = [];
  const table = el('table', {
    class: 'spira-audit-table',
    style: 'width:100%;border-collapse:collapse;font-size:12px;table-layout:fixed',
  }, [
    el('thead', {}, [
      el('tr', {}, [
        thCell('時刻', '160px'),
        thCell('実行者', '180px'),
        thCell('アクション', '160px'),
        thCell('対象', '110px'),
        thCell('詳細', 'auto'),
      ]),
    ]),
    tbody,
  ]);

  function thCell(label: string, w: string): HTMLElement {
    return el('th', {
      style: `text-align:left;padding:6px 8px;border-bottom:2px solid var(--line);font-size:11px;color:var(--ink-3);text-transform:uppercase;width:${w}`,
    }, [label]);
  }
  function tdCell(content: Node | string, opts: { mono?: boolean; truncate?: boolean } = {}): HTMLElement {
    const style = [
      'padding:6px 8px',
      'border-bottom:1px solid var(--line)',
      'vertical-align:top',
      opts.mono ? 'font-family:ui-monospace,Menlo,monospace' : '',
      opts.truncate ? 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap' : 'word-break:break-word',
    ].filter(Boolean).join(';');
    const node = typeof content === 'string' ? document.createTextNode(content) : content;
    return el('td', { style }, [node]);
  }

  function renderRows(records: AuditRecord[]): void {
    tbody.innerHTML = '';
    if (records.length === 0) {
      tbody.appendChild(el('tr', {}, [
        el('td', {
          colspan: '5',
          style: 'padding:24px;text-align:center;color:var(--ink-3)',
        }, ['該当するログがありません']),
      ]));
      return;
    }
    for (const r of records) {
      const actor = (r.actorName || r.actorEmail || '(不明)') +
        (r.actorEmail && r.actorName ? ` <${r.actorEmail}>` : '');
      const actionLabel = AUDIT_ACTION_LABEL[r.action] ?? r.action;
      const target = r.ticketId > 0
        ? `#${String(r.ticketId).padStart(5, '0')}`
        : '-';
      let detailsNode: Node | string = '';
      if (r.details) {
        try {
          const parsed = JSON.parse(r.details) as Record<string, unknown>;
          detailsNode = el('pre', {
            style: 'margin:0;font-family:ui-monospace,Menlo,monospace;font-size:11px;white-space:pre-wrap;word-break:break-word;color:var(--ink-2)',
          }, [JSON.stringify(parsed, null, 2)]);
        } catch {
          detailsNode = r.details;
        }
      }
      tbody.appendChild(el('tr', {}, [
        tdCell(fmtDateTime(r.timestamp), { mono: true }),
        tdCell(actor, { truncate: true }),
        tdCell(`${actionLabel}`),
        tdCell(target, { mono: true }),
        tdCell(detailsNode),
      ]));
    }
  }

  async function runSearch(): Promise<void> {
    searchBtn.setAttribute('disabled', '');
    countLabel.textContent = '結果: 読み込み中…';
    try {
      const opts: {
        fromTime?: string; toTime?: string; ticketId?: number;
        action?: AuditAction; actorEmail?: string; limit: number;
      } = {
        limit: parseInt(limitSel.value, 10) || 500,
      };
      if (fromInput.value) opts.fromTime = `${fromInput.value}T00:00:00.000Z`;
      if (toInput.value)   opts.toTime   = `${toInput.value}T23:59:59.999Z`;
      const tid = parseInt(ticketInput.value, 10);
      if (Number.isFinite(tid) && tid > 0) opts.ticketId = tid;
      if (actionSel.value) opts.action = actionSel.value as AuditAction;
      if (actorInput.value.trim()) opts.actorEmail = actorInput.value.trim();
      const records = await getRepo().listAudit(opts);
      currentResults = records;
      renderRows(records);
      countLabel.textContent = `結果: ${records.length} 件`;
    } catch (e) {
      toast(root, `検索失敗: ${(e as Error).message}`, 'error');
      countLabel.textContent = '結果: エラー';
    } finally {
      searchBtn.removeAttribute('disabled');
    }
  }

  function exportCsv(): void {
    if (currentResults.length === 0) {
      toast(root, '結果がありません', 'warn');
      return;
    }
    const header = ['Timestamp', 'Actor', 'Action', 'TicketId', 'TargetType', 'TargetId', 'Details'];
    const lines = [header.join(',')];
    for (const r of currentResults) {
      const cols = [
        r.timestamp,
        (r.actorName || '') + (r.actorEmail ? ` <${r.actorEmail}>` : ''),
        r.action,
        String(r.ticketId),
        r.targetType,
        r.targetId != null ? String(r.targetId) : '',
        r.details ?? '',
      ];
      lines.push(cols.map(c => `"${String(c).replace(/"/g, '""')}"`).join(','));
    }
    const blob = new Blob(['﻿' + lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `spira-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  // ── Layout ───────────────────────────────────────────────────────
  const filterGrid = el('div', {
    style: 'display:grid;grid-template-columns:80px 1fr;gap:var(--s-3) var(--s-4);align-items:center;margin-bottom:var(--s-4)',
  }, [
    el('label', { style: LABEL_STYLE }, ['期間']),
    el('div', { style: 'display:flex;gap:var(--s-2);align-items:center;flex-wrap:wrap' }, [
      fromInput,
      el('span', { style: 'color:var(--ink-3)' }, ['〜']),
      toInput,
    ]),
    el('label', { style: LABEL_STYLE }, ['アクション']),
    actionSel,
    el('label', { style: LABEL_STYLE }, ['チケット']),
    el('div', { style: 'display:flex;gap:var(--s-2);align-items:center;flex-wrap:wrap' }, [
      ticketInput,
      el('span', { style: 'color:var(--ink-3);font-size:var(--fs-xs)' }, ['(0=指定なし)']),
    ]),
    el('label', { style: LABEL_STYLE }, ['実行者']),
    actorInput,
    el('label', { style: LABEL_STYLE }, ['取得件数']),
    el('div', { style: 'display:flex;gap:var(--s-3);align-items:center' }, [
      limitSel,
      searchBtn,
      csvBtn,
      countLabel,
    ]),
  ]);

  const retentionRow = el('div', {
    style: 'display:flex;align-items:center;gap:var(--s-3);padding:var(--s-3) var(--s-4);background:var(--paper-2);border-radius:var(--r-2);margin-bottom:var(--s-4);font-size:var(--fs-sm)',
  }, [
    el('span', { style: 'color:var(--ink-3)' }, ['保持期間 (日):']),
    retentionInput,
    el('span', { style: 'color:var(--ink-3);font-size:var(--fs-xs)' }, [
      `(${minMax.min}〜${minMax.max} 日、既定 ${minMax.default} 日 — 期限切れの行は起動時に自動削除)`,
    ]),
    retentionSaveBtn,
  ]);

  const tableWrap = el('div', {
    style: 'border:1px solid var(--line);border-radius:var(--r-2);max-height:60vh;overflow:auto;background:var(--paper)',
  }, [table]);

  const body = el('div', { style: 'max-width:1100px' }, [
    el('p', { style: 'margin:0 0 var(--s-3);font-size:var(--fs-sm);color:var(--ink-3);line-height:1.6' }, [
      'チケット管理の操作履歴 (チケット属性変更・受信履歴追加・メモ追加/削除 等) を表示します。' +
      'メモの「内容編集」は記録対象外です (SP の Editor 列で更新者・更新時刻は追えます)。',
    ]),
    retentionRow,
    filterGrid,
    tableWrap,
  ]);

  // 初期検索
  void runSearch();

  openModal(root, {
    title: '監査ログ',
    body,
    size: 'lg',
    primaryLabel: '閉じる',
    hideCancel: true,
  });
}
