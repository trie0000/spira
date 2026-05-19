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

// 既存設定モーダル群
import {
  openInternalMembersModal,
  openTicketIdFormatModal,
  openTeamsChannelsModal,
  openVersionModal,
  openOptionsModal,
  openResetConfirmModal,
} from './shell';
import { openAiSettingsModal } from './aiSettingsModal';
import { openAuditLogModal } from './auditLogModal';

// ── 設定項目定義 ────────────────────────────────────────────────────
interface SettingItem {
  key: string;
  label: string;
  /** 右パネルに表示するインライン要素を返す。Promise 可。 */
  render: (root: HTMLElement, onClose: () => void) => HTMLElement | Promise<HTMLElement>;
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

/** 既存モーダル直接起動セクション用の共通テンプレート。
 *  説明文 + 「編集 UI を開く」ボタンで、複雑な編集 UI に飛ばす。 */
function renderModalLauncherPanel(args: {
  title: string;
  description: HTMLElement | string;
  buttonLabel: string;
  onClick: () => void;
  danger?: boolean;
}): HTMLElement {
  const btn = el('button', {
    class: 'spira-btn ' + (args.danger ? '' : 'spira-btn--primary'),
    style: args.danger ? 'background:#dc2626;color:#fff;border:0' : '',
    onclick: args.onClick,
  }, [
    el('span', { html: icon(args.danger ? 'trash' : 'edit'), style: 'display:inline-flex;width:14px;height:14px' }),
    args.buttonLabel,
  ]);
  return el('div', {}, [
    el('h2', { style: TITLE }, [args.title]),
    el('div', {
      style: args.danger
        ? DESC + ';border-left:3px solid #dc2626;background:rgba(239,68,68,0.05)'
        : DESC,
    }, typeof args.description === 'string' ? [args.description] : [args.description]),
    btn,
  ]);
}

// ── インライン: 受信同期間隔 ────────────────────────────────────────
async function renderSyncIntervalPanel(): Promise<HTMLElement> {
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

  const saveBtn = el('button', {
    class: 'spira-btn spira-btn--primary',
    onclick: async () => {
      const raw = parseInt(input.value, 10);
      if (!Number.isFinite(raw) || raw < 0) {
        toast(getRoot(), '0 以上の数値を入力してください', 'error');
        return;
      }
      if (raw > 0 && raw < MIN_SEC) {
        toast(getRoot(), `最小 ${MIN_SEC} 秒以上を指定してください (0 = OFF)`, 'error');
        return;
      }
      if (raw > MAX_SEC) {
        toast(getRoot(), `最大 ${MAX_SEC} 秒以下にしてください`, 'error');
        return;
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
      }
    },
  }, ['保存']);

  return el('div', {}, [
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
    el('div', { style: 'display:flex;flex-wrap:wrap;gap:4px;margin-bottom:var(--s-4)' }, [
      el('span', { style: 'color:var(--ink-3);font-size:var(--fs-xs);margin-right:4px;align-self:center' }, ['プリセット:']),
      presetBtn('OFF', 0),
      presetBtn('30秒', 30),
      presetBtn('60秒 (既定)', 60),
      presetBtn('2分', 120),
      presetBtn('5分', 300),
      presetBtn('15分', 900),
    ]),
    saveBtn,
  ]);
}

// ── インライン: 文字サイズ ─────────────────────────────────────────
function renderFontSizePanel(): HTMLElement {
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
  return el('div', {}, [
    el('h2', { style: TITLE }, ['文字サイズ']),
    el('div', { style: DESC }, [
      'チケット一覧・詳細・設定モーダル・ヘルプ等、Spira 全画面で共通の文字サイズスケールを切り替えます。',
      el('br'),
      '選択した瞬間に反映され、本設定は端末ローカル (localStorage) に保存されます。',
    ]),
    opt('sm', '小', '小さめ — 一覧で多くの行を一度に表示したい場合'),
    opt('md', '中 (既定)', '標準サイズ — バランス重視'),
    opt('lg', '大', '大きめ — 視認性重視・長時間作業向け'),
  ]);
}

// ── インライン: 開発者モード ────────────────────────────────────────
function renderDeveloperModePanel(): HTMLElement {
  const checkbox = el('input', {
    type: 'checkbox',
    style: 'width:16px;height:16px;cursor:pointer',
    ...(isDeveloperMode() ? { checked: 'checked' } : {}),
  }) as HTMLInputElement;

  const saveBtn = el('button', {
    class: 'spira-btn spira-btn--primary',
    onclick: () => {
      setDeveloperMode(checkbox.checked);
      toast(getRoot(),
        checkbox.checked ? '開発者モードを有効にしました' : '開発者モードを無効にしました',
        'ok',
      );
    },
  }, ['保存']);

  return el('div', {}, [
    el('h2', { style: TITLE }, ['開発者モード']),
    el('div', { style: DESC }, [
      '実験的機能・直接 API 接続オプションを有効化するためのフラグです。',
      '通常運用では OFF のままにしてください。',
      el('br'),
      '※ この設定は端末ローカル (localStorage) に保存され、他のメンバーには共有されません。',
    ]),
    el('label', {
      style: 'display:inline-flex;align-items:center;gap:var(--s-3);cursor:pointer;' +
             'padding:var(--s-3);background:var(--paper-2);border-radius:var(--r-2);margin-bottom:var(--s-4)',
    }, [
      checkbox,
      el('span', { style: 'font-size:var(--fs-sm);color:var(--ink)' }, ['開発者モードを有効にする']),
    ]),
    el('div', { style: 'margin-bottom:var(--s-3)' }, [saveBtn]),
  ]);
}

// ── インライン: バージョン情報 (読み取り専用) ───────────────────────
function renderVersionPanel(root: HTMLElement, onClose: () => void): HTMLElement {
  return renderModalLauncherPanel({
    title: 'バージョン管理',
    description:
      '現在ロード中の Spira ビルドと SP 上に登録された最新版を比較します。' +
      '新規ビルドを配布後はここで「最新として登録」を実行し、古いブックマーク利用者に更新案内を出します。',
    buttonLabel: 'バージョン管理を開く',
    onClick: () => { onClose(); openVersionModal(root); },
  });
}

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
          render: (root, onClose) => renderModalLauncherPanel({
            title: 'チケット ID 形式',
            description:
              '件名タグ (例: #ABC-0001) の接頭辞と桁数を設定します。' +
              '起票時の自動付与・メール件名のタグ解析・Teams スレッド連携の全箇所で使われます。',
            buttonLabel: '編集 UI を開く',
            onClick: () => { onClose(); openTicketIdFormatModal(root); },
          }),
        },
        {
          key: 'members',
          label: '内部メンバー',
          render: (root, onClose) => renderModalLauncherPanel({
            title: '内部メンバー設定',
            description:
              '社内ドメインや AD ユーザを登録します。ここに登録した送信者のカードは「内部」バッジで表示されます。',
            buttonLabel: '編集 UI を開く',
            onClick: () => { onClose(); openInternalMembersModal(root); },
          }),
        },
        {
          key: 'dept',
          label: '部門の選択肢',
          render: (root, onClose) => renderModalLauncherPanel({
            title: '部門の選択肢',
            description: 'チケット属性「部門」のプルダウン候補を編集します。Forms 取り込みの振り分けにも使われます。',
            buttonLabel: '編集 UI を開く',
            onClick: () => { onClose(); openOptionsModal(root, 'dept'); },
          }),
        },
        {
          key: 'category',
          label: '問い合わせ種別の選択肢',
          render: (root, onClose) => renderModalLauncherPanel({
            title: '問い合わせ種別の選択肢',
            description: 'チケット属性「問い合わせ種別」のプルダウン候補を編集します。',
            buttonLabel: '編集 UI を開く',
            onClick: () => { onClose(); openOptionsModal(root, 'category'); },
          }),
        },
      ],
    },
    {
      title: 'Teams / メール連携',
      items: [
        {
          key: 'teams-channels',
          label: 'Teams チャネル',
          render: (root, onClose) => renderModalLauncherPanel({
            title: 'Teams チャネル設定',
            description:
              'Spira が Teams に親メッセージを投稿する宛先チャネル群を登録します。' +
              'PA フロー②/④ もここに登録した channelId / teamId を参照します。',
            buttonLabel: '編集 UI を開く',
            onClick: () => { onClose(); openTeamsChannelsModal(root); },
          }),
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
          render: (_root, onClose) => renderModalLauncherPanel({
            title: 'AI 設定',
            description:
              'チケット詳細右ペインの AI チャットで使う社内 AI ゲートウェイの API キー・ベース URL・モデルを設定します。',
            buttonLabel: '編集 UI を開く',
            onClick: () => { onClose(); openAiSettingsModal(); },
          }),
        },
      ],
    },
    {
      title: '運用',
      items: [
        {
          key: 'version',
          label: 'バージョン管理',
          render: (root, onClose) => renderVersionPanel(root, onClose),
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

  // close handle (filled in once openModal returns)
  let closeModal: (() => void) | null = null;
  const onClose = (): void => { closeModal?.(); };

  const findItem = (key: string): SettingItem | null => {
    for (const g of groups) for (const it of g.items) if (it.key === key) return it;
    return null;
  };

  const renderDetail = async (): Promise<void> => {
    const item = findItem(activeKey);
    if (!item) return;
    detailPane.replaceChildren(el('div', { style: 'color:var(--ink-3);font-size:var(--fs-sm)' }, ['読み込み中…']));
    const content = await item.render(root, onClose);
    detailPane.replaceChildren(content);
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
    style: 'display:flex;height:min(620px,75vh);width:100%;margin:0;overflow:hidden;border-radius:var(--r-2)',
  }, [sideNav, detailPane]);

  const handle = openModal(getRoot(), {
    title: '⚙ 設定',
    body,
    size: 'xl',
    primaryLabel: '閉じる',
    onPrimary: async () => { /* close only */ },
  });
  closeModal = () => handle.close();
}
