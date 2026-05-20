// 設定ハブモーダル — 左サイドナビ + 右パネル (VSCode 風)。
// 右パネルには既存設定モーダル本体を「埋め込み起動」する形で展開する。
//
// シンプル設定 (Sync 間隔 / 開発者モード) は完全にインラインで実装。
// 複雑な編集 UI (内部メンバー / Teams チャネル / AI 設定 / 監査ログ等) は
// 既存の openXxxModal() を直接呼び、ハブはそのまま開いたままにしておく
// (= モーダルが上に重なる)。これで「設定の項目をクリック → 即編集 UI」
// が体感できる (中継の「開く」ボタンを廃止)。

import { el } from '../utils/dom';
import { icon } from '../icons';
import { openModal } from '../components/modal';
import { toast } from '../components/toast';
import { getRepo } from '../api/repo';
import { isDeveloperMode, setDeveloperMode } from '../utils/devMode';
import { getFontSize, setFontSize, type FontSize } from '../utils/fontSize';
import { getFormsAnalyticsUrl, setFormsAnalyticsUrl, extractFormId, normalizeAnalyticsUrl } from '../utils/formsSettings';
import { getReplyMlRaw, setReplyMlRaw, parseAddressList } from '../utils/mailSettings';

// 既存設定モーダル群
import {
  buildTicketIdFormatPanel,
  buildTeamsChannelsPanel,
  buildInternalMembersPanel,
  buildVersionPanel,
  buildOptionsPanel,
  buildTagDictionaryPanel,
  openResetConfirmModal,
} from './shell';
import { buildAiSettingsPanel } from './aiSettingsModal';
import { openAuditLogModal } from './auditLogModal';

// ── 設定項目定義 ────────────────────────────────────────────────────
interface SettingPanel {
  body: HTMLElement;
  /** モーダル右下の共通「保存」ボタンが呼ぶ。未指定なら保存ボタン非表示。 */
  save?: () => Promise<void> | void;
}
interface SettingItem {
  key: string;
  label: string;
  /** 右パネルに表示する panel (body + save) を返す。Promise 可。 */
  render: (root: HTMLElement, onClose: () => void) => SettingPanel | Promise<SettingPanel>;
  danger?: boolean;
}
interface SettingGroup {
  title: string;
  items: SettingItem[];
}

function getRoot(): HTMLElement {
  return (document.querySelector<HTMLElement>('#spira-root') ?? document.body);
}

// ── 共通スタイル ────────────────────────────────────────────────────
const TITLE = 'margin:0 0 var(--s-3);font-size:var(--fs-lg);font-weight:600;color:var(--ink)';
const DESC = 'margin:0 0 var(--s-4);font-size:var(--fs-sm);line-height:1.7;color:var(--ink-2);' +
  'background:var(--paper-2);border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-3) var(--s-4)';

/** インラインパネル共通テンプレート。タイトル + 説明 + body を返す。
 *  保存ボタンはモーダル右下の共通ボタンに集約 (panel.save で渡す)。 */
function inlinePanel(args: {
  title: string;
  hint?: string;
  body: HTMLElement;
  save?: () => Promise<void> | void;
}): SettingPanel {
  const wrap = el('div', {}, [
    el('h2', { style: TITLE }, [args.title]),
    ...(args.hint ? [el('div', { style: DESC }, [args.hint])] : []),
    args.body,
  ]);
  return { body: wrap, save: args.save };
}

/** 既存モーダル直接起動セクション用の共通テンプレート。
 *  説明文 + 「編集 UI を開く」ボタンで、複雑な編集 UI に飛ばす。
 *  (現状: AuditLog / SP リセット 等の Composite 機能のみで使用) */
function renderModalLauncherPanel(args: {
  title: string;
  description: HTMLElement | string;
  buttonLabel: string;
  onClick: () => void;
  danger?: boolean;
}): SettingPanel {
  const btn = el('button', {
    class: 'spira-btn ' + (args.danger ? '' : 'spira-btn--primary'),
    style: args.danger ? 'background:#dc2626;color:#fff;border:0' : '',
    onclick: args.onClick,
  }, [
    el('span', { html: icon(args.danger ? 'trash' : 'edit'), style: 'display:inline-flex;width:14px;height:14px' }),
    args.buttonLabel,
  ]);
  const body = el('div', {}, [
    el('h2', { style: TITLE }, [args.title]),
    el('div', {
      style: args.danger
        ? DESC + ';border-left:3px solid #dc2626;background:rgba(239,68,68,0.05)'
        : DESC,
    }, typeof args.description === 'string' ? [args.description] : [args.description]),
    btn,
  ]);
  return { body };
}

// ── インライン: 受信同期間隔 ────────────────────────────────────────
async function renderSyncIntervalPanel(): Promise<SettingPanel> {
  const SETTING_KEY = 'inboxSyncIntervalSec';
  const DEFAULT_SEC = 60;
  const MIN_SEC = 10;
  const MAX_SEC = 3600;
  const repo = getRepo();
  let current = DEFAULT_SEC;
  try {
    const v = await repo.getSetting(SETTING_KEY);
    if (v != null) {
      const n = parseInt(v, 10);
      if (Number.isFinite(n) && n >= 0) current = n;
    }
  } catch { /* ignore */ }

  const input = el('input', {
    type: 'number', class: 'spira-input',
    min: '0', max: String(MAX_SEC), step: '5',
    value: String(current),
    style: 'width:120px',
  }) as HTMLInputElement;

  const presetBtn = (label: string, sec: number): HTMLElement => el('button', {
    type: 'button', class: 'spira-btn spira-btn-sm',
    style: 'margin-right:6px',
    onclick: () => { input.value = String(sec); },
  }, [label]);

  const save = async (): Promise<void> => {
    const raw = parseInt(input.value, 10);
    if (!Number.isFinite(raw) || raw < 0) {
      toast(getRoot(), '0 以上の数値を入力してください', 'error');
      throw new Error('invalid');
    }
    if (raw > 0 && raw < MIN_SEC) {
      toast(getRoot(), `最小 ${MIN_SEC} 秒以上を指定してください (0 = OFF)`, 'error');
      throw new Error('invalid');
    }
    if (raw > MAX_SEC) {
      toast(getRoot(), `最大 ${MAX_SEC} 秒以下にしてください`, 'error');
      throw new Error('invalid');
    }
    try {
      await repo.setSetting(SETTING_KEY, String(raw));
      const { restartAutoSync } = await import('../main');
      void restartAutoSync();
      toast(getRoot(),
        raw === 0
          ? '自動更新を OFF にしました (起動時 + 手動同期のみ)'
          : `自動更新を ${raw} 秒間隔に設定しました`,
        'ok',
      );
    } catch (e) {
      toast(getRoot(), `保存失敗: ${(e as Error).message}`, 'error');
      throw e;
    }
  };

  const body = el('div', {}, [
    el('h2', { style: TITLE }, ['受信同期 — 自動更新間隔']),
    el('div', { style: DESC }, [
      '受信一覧を自動で再取得する間隔 (秒) を設定します。既定 60 秒。',
      el('br'),
      `最小 ${MIN_SEC} 秒 / 最大 ${MAX_SEC} 秒。0 を指定すると自動更新を停止 (起動時 + 手動同期のみ)。`,
    ]),
    el('div', { style: 'display:flex;align-items:center;gap:var(--s-3);margin-bottom:var(--s-3)' }, [
      el('label', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, ['同期間隔:']),
      input,
      el('span', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, ['秒']),
    ]),
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px' }, [
      el('span', { style: 'color:var(--ink-3);font-size:var(--fs-xs);margin-right:4px;align-self:center' }, ['プリセット:']),
      presetBtn('OFF', 0),
      presetBtn('30秒', 30),
      presetBtn('60秒 (既定)', 60),
      presetBtn('2分', 120),
      presetBtn('5分', 300),
      presetBtn('15分', 900),
    ]),
  ]);
  return { body, save };
}

// ── インライン: Forms 連携 ─────────────────────────────────────────
async function renderFormsSettingsPanel(): Promise<SettingPanel> {
  const current = (await getFormsAnalyticsUrl()) ?? '';

  const urlInput = el('input', {
    type: 'url',
    class: 'spira-input',
    placeholder: 'https://forms.office.com/Pages/AnalysisPage.aspx?id=...',
    value: current,
    style: 'width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px',
  }) as HTMLInputElement;

  const previewLabel = el('span', { style: 'color:var(--ink-3);font-size:var(--fs-xs);width:80px;flex-shrink:0' }, ['Form ID:']);
  const previewValue = el('code', {
    style: 'font-family:ui-monospace,Menlo,monospace;font-size:12px;background:var(--paper-2);padding:2px 6px;border-radius:3px;word-break:break-all',
  }, ['(未入力)']);
  const previewRow = el('div', {
    style: 'display:flex;gap:var(--s-2);align-items:center;margin-top:var(--s-2);min-height:24px',
  }, [previewLabel, previewValue]);

  const refreshPreview = (): void => {
    const fid = extractFormId(urlInput.value);
    if (fid) {
      previewValue.textContent = fid;
      previewValue.style.color = 'var(--ink-2)';
    } else if (urlInput.value.trim()) {
      previewValue.textContent = '⚠ URL から id= が抽出できません';
      previewValue.style.color = 'var(--danger)';
    } else {
      previewValue.textContent = '(未入力)';
      previewValue.style.color = 'var(--ink-3)';
    }
  };
  refreshPreview();
  urlInput.addEventListener('input', refreshPreview);

  const clearBtn = el('button', {
    type: 'button',
    class: 'spira-btn spira-btn--ghost spira-btn--sm',
    onclick: () => { urlInput.value = ''; refreshPreview(); },
  }, ['クリア']);

  const save = async (): Promise<void> => {
    const raw = urlInput.value.trim();
    if (!raw) {
      await setFormsAnalyticsUrl(null);
      toast(getRoot(), 'Forms URL の登録を解除しました', 'ok');
      return;
    }
    if (!extractFormId(raw)) {
      toast(getRoot(), 'URL から Form ID を抽出できません。`id=<...>` を含む URL を貼り付けてください', 'error');
      throw new Error('invalid');
    }
    // 保存は正規化済み URL (AnalysisPage 形式) で揃える
    await setFormsAnalyticsUrl(normalizeAnalyticsUrl(raw));
    toast(getRoot(), 'Forms 回答一覧 URL を保存しました', 'ok');
  };

  const body = el('div', {}, [
    el('h2', { style: TITLE }, ['Forms 連携']),
    el('div', { style: DESC }, [
      'Forms 起票チケットの本文に「回答一覧を開く」リンクを表示するための URL を 1 つ登録します。',
      el('br'),
      'Forms 管理画面で対象フォームを開いた状態のブラウザ URL バーから ',
      el('code', { style: 'background:var(--paper-2);padding:1px 6px;border-radius:3px;font-size:0.92em' }, ['?id=<長い文字列>']),
      ' を含む URL を丸ごとコピーして貼り付けてください。',
      el('br'),
      '保存時に AnalysisPage 形式 (',
      el('code', { style: 'background:var(--paper-2);padding:1px 6px;border-radius:3px;font-size:0.92em' }, ['https://forms.office.com/Pages/AnalysisPage.aspx?id=...']),
      ') に整形されます。',
    ]),
    el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-2)' }, [
      el('label', { style: 'font-size:var(--fs-sm);color:var(--ink)' }, ['Forms URL']),
      el('div', { style: 'display:flex;gap:var(--s-2);align-items:flex-start' }, [
        el('div', { style: 'flex:1;min-width:0' }, [urlInput]),
        clearBtn,
      ]),
      previewRow,
    ]),
  ]);
  return { body, save };
}

// ── インライン: 文字サイズ ─────────────────────────────────────────
function renderFontSizePanel(): SettingPanel {
  const current = getFontSize();
  const opt = (v: FontSize, label: string, sample: string): HTMLElement => {
    const id = `spira-font-${v}`;
    const radio = el('input', {
      type: 'radio', name: 'spira-font-size', id, value: v,
      ...(v === current ? { checked: 'checked' } : {}),
      style: 'margin:0;flex-shrink:0',
      onchange: () => {
        if ((radio as HTMLInputElement).checked) {
          setFontSize(v);
        }
      },
    }) as HTMLInputElement;
    return el('label', {
      for: id,
      style: 'display:flex;align-items:center;gap:var(--s-3);cursor:pointer;' +
             'padding:var(--s-3) var(--s-4);background:var(--paper-2);border:1px solid var(--line);' +
             'border-radius:var(--r-2);margin-bottom:var(--s-2)',
    }, [
      radio,
      el('div', { style: 'flex:1' }, [
        el('div', { style: 'font-size:var(--fs-sm);color:var(--ink);font-weight:600' }, [label]),
        el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-top:2px' }, [sample]),
      ]),
    ]);
  };
  const body = el('div', {}, [
    el('h2', { style: TITLE }, ['文字サイズ']),
    el('div', { style: DESC }, [
      'Spira 全画面で共通の文字サイズスケールを切り替えます。',
      el('br'),
      'ラジオを選択した瞬間に反映され、端末ローカル (localStorage) に保存されます。',
    ]),
    opt('sm', '小', '小さめ — 一覧で多くの行を一度に表示したい場合'),
    opt('md', '中 (既定)', '標準サイズ — バランス重視'),
    opt('lg', '大', '大きめ — 視認性重視・長時間作業向け'),
  ]);
  return { body }; // 即時反映なので保存ボタン不要
}

// ── メール返信 — 共通 ML (Cc / Reply-To) ──────────────────────────
//
// 「📧 返信メール作成」モーダルを開いた時に自動的に Cc 欄に入り、relay 経由で
// Outlook 下書きの ReplyRecipientNames (= Reply-To) にもセットされる ML を
// 1〜数件登録する。SpiraSettings (key: mail.reply-ml) に文字列 1 行で保存。
function buildMailReplySettingsPanel(): { body: HTMLElement; save: () => Promise<void> } {
  // 既存値ロード (非同期だが、初期表示は空にしておいて流し込む)
  const input = el('input', {
    type: 'text',
    class: 'spira-input',
    placeholder: 'support-ml@example.com, alt-ml@example.com',
    style: 'width:100%;font-family:ui-monospace,Menlo,monospace;font-size:12px',
  }) as HTMLInputElement;
  void getReplyMlRaw().then(v => { input.value = v; refreshPreview(); });

  const previewLabel = el('span', {
    style: 'color:var(--ink-3);font-size:var(--fs-xs);width:80px;flex-shrink:0',
  }, ['解析結果:']);
  const previewValue = el('div', {
    style: 'font-family:ui-monospace,Menlo,monospace;font-size:12px;color:var(--ink-2);' +
           'background:var(--paper-2);padding:4px 8px;border-radius:3px;word-break:break-all;flex:1',
  }, ['(未入力)']);
  const previewRow = el('div', {
    style: 'display:flex;gap:var(--s-2);align-items:flex-start;margin-top:var(--s-2);min-height:24px',
  }, [previewLabel, previewValue]);

  const refreshPreview = (): void => {
    const list = parseAddressList(input.value);
    if (list.length === 0) {
      previewValue.textContent = input.value.trim() ? '⚠ 有効な email アドレスが見つかりません' : '(未入力)';
      previewValue.style.color = input.value.trim() ? 'var(--danger)' : 'var(--ink-3)';
    } else {
      previewValue.textContent = list.join(' / ');
      previewValue.style.color = 'var(--ink-2)';
    }
  };
  input.addEventListener('input', refreshPreview);

  const save = async (): Promise<void> => {
    const raw = input.value.trim();
    if (!raw) {
      await setReplyMlRaw(null);
      toast(getRoot(), '返信用 ML の登録を解除しました', 'ok');
      return;
    }
    const list = parseAddressList(raw);
    if (list.length === 0) {
      toast(getRoot(), '有効な email アドレスが見つかりません', 'error');
      throw new Error('invalid');
    }
    // 正規化済みリストで保存 (重複・空白除去後の表記揺れを抑える)
    await setReplyMlRaw(list.join(', '));
    toast(getRoot(), `返信用 ML を保存しました (${list.length} 件)`, 'ok');
  };

  const body = el('div', {}, [
    el('h2', { style: TITLE }, ['メール返信 — 共通 ML']),
    el('div', { style: DESC }, [
      'チケット詳細の「📧 返信メール作成」モーダルを開いた瞬間に自動的に Cc 欄に入り、',
      'さらに Outlook 下書きの ', el('strong', {}, ['Reply-To']),
      ' ヘッダにも設定される ML / 共有アドレスを登録します。',
      el('br'),
      '複数指定する場合はカンマ区切り (例: ', el('code', {}, ['support-ml@example.com, alt@example.com']), ')。',
      el('br'),
      el('br'),
      '★ ', el('strong', {}, ['なぜ Reply-To に入れるか']),
      ': 申請者が普通に「返信」を押したときに自動で ML 宛になり、',
      'チーム全員が引き続き Spira に取り込めるようにするため。',
      '「全員に返信」を押し忘れて返事が個人 1 人だけに行くケースを防げます。',
    ]),
    el('div', { class: 'spira-field' }, [
      el('label', { class: 'spira-field-label' }, ['ML / 共有アドレス']),
      input,
      previewRow,
    ]),
  ]);
  return { body, save };
}

// ── インライン: 開発者モード ────────────────────────────────────────
function renderDeveloperModePanel(): SettingPanel {
  const checkbox = el('input', {
    type: 'checkbox',
    style: 'width:16px;height:16px;cursor:pointer',
    ...(isDeveloperMode() ? { checked: 'checked' } : {}),
  }) as HTMLInputElement;

  const save = async (): Promise<void> => {
    setDeveloperMode(checkbox.checked);
    toast(getRoot(),
      checkbox.checked ? '開発者モードを有効にしました' : '開発者モードを無効にしました',
      'ok',
    );
  };

  const body = el('div', {}, [
    el('h2', { style: TITLE }, ['開発者モード']),
    el('div', { style: DESC }, [
      '実験的機能・直接 API 接続オプションを有効化するためのフラグです。',
      '通常運用では OFF のままにしてください。',
      el('br'),
      '※ この設定は端末ローカル (localStorage) に保存され、他のメンバーには共有されません。',
    ]),
    el('label', {
      style: 'display:inline-flex;align-items:center;gap:var(--s-3);cursor:pointer;' +
             'padding:var(--s-3);background:var(--paper-2);border-radius:var(--r-2)',
    }, [
      checkbox,
      el('span', { style: 'font-size:var(--fs-sm);color:var(--ink)' }, ['開発者モードを有効にする']),
    ]),
  ]);
  return { body, save };
}

// (旧 renderVersionPanel は buildVersionPanel 直利用に置き換え済み)

// ── パネル群定義 ────────────────────────────────────────────────────
function buildGroups(): SettingGroup[] {
  return [
    {
      title: '表示',
      items: [
        {
          key: 'font-size',
          label: '文字サイズ',
          render: () => renderFontSizePanel(),
        },
      ],
    },
    {
      title: '基本',
      items: [
        {
          key: 'id-format',
          label: 'チケット ID 形式',
          render: (root) => {
            const { body, save } = buildTicketIdFormatPanel(root);
            return inlinePanel({
              title: 'チケット ID 形式',
              hint: '件名タグ (例: [CASE#00001]) の接頭辞を設定します。' +
                '起票時の自動付与・メール件名のタグ解析・Teams スレッド連携の全箇所で使われます。',
              body, save,
            });
          },
        },
        {
          key: 'members',
          label: '内部メンバー',
          render: (root) => {
            const { body, save } = buildInternalMembersPanel(root);
            return inlinePanel({
              title: '内部メンバー設定',
              hint: '社内ドメインや AD ユーザを登録します。ここに登録した送信者のカードは「内部」バッジで表示されます。',
              body, save,
            });
          },
        },
        {
          key: 'status',
          label: 'ステータスの選択肢',
          render: (root) => {
            const { body, save } = buildOptionsPanel(root, 'status');
            return inlinePanel({
              title: 'ステータスの選択肢',
              hint:
                'チケット「ステータス」のプルダウン候補。並び順は変更可能。' +
                '※ SP の Tickets リスト側 Status 列 (Choice) にも同名の選択肢が必要 (既存値を変更する場合は SP リスト設定でも手動追加してください)。',
              body, save,
            });
          },
        },
        {
          key: 'priority',
          label: '影響度の選択肢',
          render: (root) => {
            const { body, save } = buildOptionsPanel(root, 'priority');
            return inlinePanel({
              title: '影響度の選択肢',
              hint:
                'チケット「影響度」(旧 影響度) のプルダウン候補。Forms 自動マッピングと整合させるには英語の High/Medium/Low 推奨。' +
                '※ SP の Tickets リスト側 Priority 列 (Choice) にも同名の選択肢が必要。',
              body, save,
            });
          },
        },
        {
          key: 'tags',
          label: 'タグ辞書',
          render: (root) => {
            const { body, save } = buildTagDictionaryPanel(root);
            return inlinePanel({
              title: 'タグ辞書',
              hint:
                'チケットに付けるタグの辞書 (admin 管理)。利用者はここに登録された名前から選択します。' +
                ' 色・説明を設定するとチケット一覧/詳細で色付きピル表示されます。',
              body, save,
            });
          },
        },
        {
          key: 'dept',
          label: '部門の選択肢',
          render: (root) => {
            const { body, save } = buildOptionsPanel(root, 'dept');
            return inlinePanel({
              title: '部門の選択肢',
              hint: 'チケット属性「部門」のプルダウン候補を編集します。Forms 取り込みの振り分けにも使われます。',
              body, save,
            });
          },
        },
        {
          key: 'category',
          label: '問い合わせ種別の選択肢',
          render: (root) => {
            const { body, save } = buildOptionsPanel(root, 'category');
            return inlinePanel({
              title: '問い合わせ種別の選択肢',
              hint: 'チケット属性「問い合わせ種別」のプルダウン候補を編集します。',
              body, save,
            });
          },
        },
      ],
    },
    {
      title: 'Teams / メール連携',
      items: [
        {
          key: 'teams-channels',
          label: 'Teams チャネル',
          render: (root) => {
            const { body, save } = buildTeamsChannelsPanel(root);
            return inlinePanel({
              title: 'Teams チャネル設定',
              hint: 'Spira が Teams に親メッセージを投稿する宛先チャネル群を登録します。' +
                'PA フロー②/④ もここに登録した channelId / teamId を参照します。',
              body, save,
            });
          },
        },
        {
          key: 'forms',
          label: 'Forms 連携',
          render: () => renderFormsSettingsPanel(),
        },
        {
          key: 'mail-reply',
          label: 'メール返信 — 共通 ML',
          render: () => {
            const { body, save } = buildMailReplySettingsPanel();
            return inlinePanel({
              title: 'メール返信 — 共通 ML',
              hint:
                '「📧 返信メール作成」モーダルを開いたときに、自動的に Cc と Reply-To にセットされる ' +
                '共有 ML / グループアドレスを登録します。複数指定する場合はカンマ区切り。Reply-To に入れて' +
                'おくことで、申請者が「全員に返信」しなくても ML に確実に届く運用ができます。',
              body, save,
            });
          },
        },
        {
          key: 'sync-interval',
          label: '受信同期 — 自動更新間隔',
          render: () => renderSyncIntervalPanel(),
        },
      ],
    },
    {
      title: 'AI / 自動化',
      items: [
        {
          key: 'ai',
          label: 'AI 設定',
          render: () => {
            const { body, save } = buildAiSettingsPanel();
            return inlinePanel({
              title: 'AI 設定',
              hint: 'チケット詳細右ペインの AI チャットで使う社内 AI ゲートウェイ (Azure OpenAI 互換) の API キー・ベース URL・モデルを設定します。',
              body, save,
            });
          },
        },
      ],
    },
    {
      title: '運用',
      items: [
        {
          key: 'version',
          label: 'バージョン管理',
          render: (root) => {
            const { body, save } = buildVersionPanel(root);
            return inlinePanel({
              title: 'バージョン管理',
              hint: '現在ロード中の Spira ビルドと SP に登録された最新版を比較します。新規ビルド配布後はここで「最新として登録」を実行し、古いブックマーク利用者に更新案内を出します。',
              body, save,
            });
          },
        },
        {
          key: 'audit',
          label: '監査ログ',
          render: (_root, onClose) => renderModalLauncherPanel({
            title: '監査ログ',
            description: 'チケット作成・更新・削除・受信処理など、誰がいつ何をしたかの操作履歴を一覧します。',
            buttonLabel: '監査ログを開く',
            onClick: () => { onClose(); openAuditLogModal(); },
          }),
        },
        {
          key: 'developer',
          label: '開発者モード',
          render: () => renderDeveloperModePanel(),
        },
      ],
    },
    {
      title: '危険ゾーン',
      items: [
        {
          key: 'reset',
          label: 'SP リストをリセット',
          danger: true,
          render: (root, onClose) => renderModalLauncherPanel({
            title: 'SP リストをリセット',
            description:
              '⚠ 警告: Tickets / Comments / InboxMails / TeamsPostRequests を削除して再作成します。' +
              'すべての起票履歴・受信メール・スレッド対応が消えます。',
            buttonLabel: 'リセット確認画面を開く',
            danger: true,
            onClick: () => { onClose(); openResetConfirmModal(root); },
          }),
        },
      ],
    },
  ];
}

// ── モーダル本体 ────────────────────────────────────────────────────
export function openSettingsHubModal(root: HTMLElement): void {
  const groups = buildGroups();

  const sideNav = el('div', {
    style:
      'width:220px;flex-shrink:0;border-right:1px solid var(--line);' +
      'background:var(--paper-2);overflow-y:auto;padding:var(--s-2) 0',
  }, []);

  const detailPane = el('div', {
    style: 'flex:1;padding:var(--s-5) var(--s-6);overflow:auto;background:var(--paper);min-width:0',
  }, []);

  let activeKey = groups[0]!.items[0]!.key;
  // 現在アクティブなパネルの save。openModal の onPrimary がこれを呼ぶ。
  let currentSave: (() => Promise<void> | void) | null = null;

  // B1: パネルキャッシュ — 一度開いたパネルは body + save をキャッシュし、
  // 左ナビで切替・戻った時もユーザー入力中の draft (input 値や DOM 状態) を
  // 失わない。各セクションは初回表示時にのみ build される。
  // L4: 切替連打時のレースも回避できる (cached body は build 不要なので await
  // 不要 → 後勝ち上書きが発生しない)。
  const panelCache = new Map<string, SettingPanel>();
  // 切替レース防止: renderDetail に世代カウンタを付与する
  let renderToken = 0;

  let closeModal: (() => void) | null = null;
  const onClose = (): void => { closeModal?.(); };

  const findItem = (key: string): SettingItem | null => {
    for (const g of groups) for (const it of g.items) if (it.key === key) return it;
    return null;
  };

  const renderDetail = async (): Promise<void> => {
    const item = findItem(activeKey);
    if (!item) return;
    const cached = panelCache.get(activeKey);
    if (cached) {
      currentSave = cached.save ?? null;
      detailPane.replaceChildren(cached.body);
      detailPane.scrollTop = 0;
      return;
    }
    const myToken = ++renderToken;
    detailPane.replaceChildren(el('div', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, ['読み込み中…']));
    const panel = await item.render(root, onClose);
    if (myToken !== renderToken) return; // L4: stale, ユーザーは別パネルに移動済み
    panelCache.set(activeKey, panel);
    currentSave = panel.save ?? null;
    detailPane.replaceChildren(panel.body);
    detailPane.scrollTop = 0;
  };

  const renderNav = (): void => {
    const children: HTMLElement[] = [];
    for (const g of groups) {
      children.push(el('div', {
        style:
          'padding:var(--s-3) var(--s-4) var(--s-1);' +
          'font-size:var(--fs-xs);color:var(--ink-3);' +
          'text-transform:uppercase;letter-spacing:0.05em;font-weight:600',
      }, [g.title]));
      for (const it of g.items) {
        const isActive = it.key === activeKey;
        const row = el('div', {
          style:
            `display:block;padding:8px 16px;cursor:pointer;` +
            `font-size:var(--fs-sm);color:${isActive ? 'var(--ink)' : 'var(--ink-2)'};` +
            `background:${isActive ? 'var(--accent-soft)' : 'transparent'};` +
            `border-left:3px solid ${isActive ? 'var(--accent)' : 'transparent'};` +
            (it.danger ? 'color:var(--danger);' : ''),
          onclick: () => {
            activeKey = it.key;
            renderNav();
            void renderDetail();
          },
        }, [it.label]);
        children.push(row);
      }
    }
    sideNav.replaceChildren(...children);
  };

  renderNav();
  void renderDetail();

  const body = el('div', {
    style: 'display:flex;height:100%;width:100%;margin:0;overflow:hidden;border-radius:var(--r-2)',
  }, [sideNav, detailPane]);

  const handle = openModal(getRoot(), {
    title: '⚙ 設定',
    body,
    size: 'xl',
    // モーダル右下の共通保存ボタン。アクティブパネルの save を呼ぶ。
    // 保存ボタンを 1 つに集約 (キャンセルボタンは非表示、× / Esc で閉じる)。
    primaryLabel: '保存',
    hideCancel: true,
    onPrimary: async () => {
      if (currentSave) {
        try { await currentSave(); }
        catch { throw new Error('validation-failed'); }
      }
    },
  });
  closeModal = () => handle.close();
}
