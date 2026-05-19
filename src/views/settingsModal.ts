// 設定ハブモーダル — 左サイドバーで項目選択、右パネルに概要と「開く」ボタン。
// 各設定の本体 UI は既存の openXxxModal() を流用する (UI 一新で動作を変えない方針)。
//
// レイアウト:
//   ┌─────────────────────────────────────────────────────┐
//   │ ⚙ 設定                                          ✕  │
//   ├──────────────┬──────────────────────────────────────┤
//   │ 基本         │  ◆ 内部メンバー設定                  │
//   │  ▸ ID 形式   │                                       │
//   │  ▸ 内部メンバ│  チケットスレッドで「内部/外部」を   │
//   │  ▸ 部門      │  自動判定する基準ドメイン・ユーザを   │
//   │  ▸ 種別      │  登録します。                         │
//   │ 連携         │                                       │
//   │  ▸ Teams     │             [この設定を開く]          │
//   │  ▸ 同期間隔  │                                       │
//   │ AI / 自動化  │                                       │
//   │  ▸ AI 設定   │                                       │
//   │ 運用         │                                       │
//   │  ▸ バージョン│                                       │
//   │  ▸ 監査ログ  │                                       │
//   │ 危険ゾーン   │                                       │
//   │  ▸ リセット  │                                       │
//   └──────────────┴──────────────────────────────────────┘

import { el } from '../utils/dom';
import { icon } from '../icons';
import { openModal } from '../components/modal';

// 既存設定モーダル群 (本体 UI はそのまま流用)
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
import { openSyncIntervalModal } from './syncIntervalModal';

/** カテゴリ + 項目の定義。各 item の onOpen で本体モーダルを開く。 */
interface SettingItem {
  key: string;
  label: string;
  description: string;
  onOpen: (root: HTMLElement) => void;
  /** true なら破壊的操作。右パネルを警告色で表示。 */
  danger?: boolean;
}
interface SettingGroup {
  title: string;
  items: SettingItem[];
}

function buildGroups(): SettingGroup[] {
  return [
    {
      title: '基本',
      items: [
        {
          key: 'id-format',
          label: 'チケット ID 形式',
          description:
            'チケットの件名タグ (例: #ABC-0001) の接頭辞と桁数を設定します。' +
            'ここで決めた形式は新規起票時の自動付与、メール件名のタグ解析、Teams スレッド連携の全箇所で使われます。',
          onOpen: (root) => openTicketIdFormatModal(root),
        },
        {
          key: 'members',
          label: '内部メンバー',
          description:
            '受信スレッドのカードで「内部」「外部」を自動判定するための、' +
            '社内ドメインや AD ユーザを登録します。ここに登録した送信者のカードは「内部」バッジで表示され、視線誘導が分かりやすくなります。',
          onOpen: (root) => openInternalMembersModal(root),
        },
        {
          key: 'dept',
          label: '部門の選択肢',
          description:
            'チケット属性「部門」のプルダウン候補を編集します。' +
            'Forms から取り込んだ問い合わせの自動振り分けにも使われます。',
          onOpen: (root) => openOptionsModal(root, 'dept'),
        },
        {
          key: 'category',
          label: '問い合わせ種別の選択肢',
          description:
            'チケット属性「問い合わせ種別」のプルダウン候補を編集します。' +
            'Forms 取り込み時のカテゴリ自動判定にも使われます。',
          onOpen: (root) => openOptionsModal(root, 'category'),
        },
      ],
    },
    {
      title: 'Teams / メール連携',
      items: [
        {
          key: 'teams-channels',
          label: 'Teams チャネル',
          description:
            'Spira が Teams に親メッセージを投稿する宛先チャネル群を登録します。' +
            '「内部議論用」「顧客向け」のように複数登録可。PA フロー②/④ もここに登録した channelId / teamId を参照します。',
          onOpen: (root) => openTeamsChannelsModal(root),
        },
        {
          key: 'sync-interval',
          label: '受信同期 — 自動更新間隔',
          description:
            '受信一覧を自動で再取得する間隔 (秒) を設定します。' +
            '既定 60 秒。0 を指定すると自動更新を停止 (起動時 + 手動同期のみ)。',
          onOpen: () => { void openSyncIntervalModal(); },
        },
      ],
    },
    {
      title: 'AI / 自動化',
      items: [
        {
          key: 'ai',
          label: 'AI 設定',
          description:
            'チケット詳細右ペインの AI チャットで使うプロバイダ・モデル・API キーを設定します。' +
            'Claude API 直 / 社内 AI ゲートウェイ (Azure OpenAI 互換) を切り替え可能。',
          onOpen: () => openAiSettingsModal(),
        },
      ],
    },
    {
      title: '運用',
      items: [
        {
          key: 'version',
          label: 'バージョン管理',
          description:
            'Spira のビルド ID と SpiraSettings に登録された最新版を比較し、' +
            '古いブックマークを使っている利用者に更新を促す情報を表示します。',
          onOpen: (root) => openVersionModal(root),
        },
        {
          key: 'audit',
          label: '監査ログ',
          description:
            'チケット作成・更新・削除・受信メール処理など、誰がいつ何をしたかの操作履歴を一覧します。' +
            '既定 30 日保持 (SpiraSettings の audit.retention.days で変更可)。',
          onOpen: () => openAuditLogModal(),
        },
      ],
    },
    {
      title: '危険ゾーン',
      items: [
        {
          key: 'reset',
          label: 'SP リストをリセット',
          description:
            '★ 警告: Tickets / Comments / InboxMails / TeamsPostRequests を削除して再作成します。' +
            'すべての起票履歴・受信メール・スレッド対応が消えます。' +
            '主に開発・検証環境のクリーンアップ用。本番では絶対に押さないこと。',
          onOpen: (root) => openResetConfirmModal(root),
          danger: true,
        },
      ],
    },
  ];
}

function getRoot(): HTMLElement {
  return (document.querySelector<HTMLElement>('#spira-root') ?? document.body);
}

export function openSettingsHubModal(root: HTMLElement): void {
  const groups = buildGroups();

  // ── 左サイドバー: グループ + 項目 ─────────────────────────────────
  const sideNav = el('div', {
    style:
      'width:200px;flex-shrink:0;border-right:1px solid var(--line);' +
      'background:var(--paper-2);overflow-y:auto;padding:var(--s-2) 0',
  }, []);

  // ── 右パネル: 概要 + 開くボタン ────────────────────────────────────
  const detailPane = el('div', {
    style: 'flex:1;padding:var(--s-5) var(--s-6);overflow-y:auto;background:var(--paper)',
  }, []);

  // 初期表示: 最初のグループの最初の項目
  let activeKey = groups[0]!.items[0]!.key;

  const renderDetail = (item: SettingItem): void => {
    const accentBg = item.danger
      ? 'background:rgba(239,68,68,0.06);border:1px solid rgba(239,68,68,0.3)'
      : 'background:var(--paper-2);border:1px solid var(--line)';
    const openBtn = el('button', {
      class: `spira-btn ${item.danger ? '' : 'spira-btn--primary'}`,
      style: item.danger
        ? 'background:#dc2626;color:#fff;border:0'
        : '',
      onclick: () => {
        item.onOpen(root);
      },
    }, [
      el('span', { html: icon(item.danger ? 'trash' : 'edit'), style: 'display:inline-flex;width:14px;height:14px' }),
      'この設定を開く',
    ]);

    detailPane.replaceChildren(
      el('h2', { style: 'margin:0 0 var(--s-4);font-size:var(--fs-lg);font-weight:600;color:var(--ink)' }, [item.label]),
      el('div', {
        style: `${accentBg};border-radius:var(--r-2);padding:var(--s-4);` +
               `line-height:1.7;font-size:var(--fs-sm);color:var(--ink-2);margin-bottom:var(--s-5)`,
      }, [item.description]),
      el('div', { style: 'display:flex;gap:var(--s-3)' }, [openBtn]),
      el('div', {
        style: 'margin-top:var(--s-6);padding-top:var(--s-4);border-top:1px dashed var(--line);' +
               'font-size:var(--fs-xs);color:var(--ink-3);line-height:1.6',
      }, [
        '※ 「この設定を開く」を押すと、設定本体のモーダルが開きます。',
        el('br', {}),
        'ハブ画面に戻るには本体を保存またはキャンセル後、もう一度 ⚙ から「設定」を選んでください。',
      ]),
    );
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
          class: 'spira-settings-nav-item',
          style:
            `display:block;padding:8px 16px;cursor:pointer;` +
            `font-size:var(--fs-sm);color:${isActive ? 'var(--ink)' : 'var(--ink-2)'};` +
            `background:${isActive ? 'var(--accent-soft)' : 'transparent'};` +
            `border-left:3px solid ${isActive ? 'var(--accent)' : 'transparent'};` +
            (it.danger ? 'color:var(--danger);' : ''),
          onclick: () => {
            activeKey = it.key;
            renderNav();
            renderDetail(it);
          },
        }, [it.label]);
        children.push(row);
      }
    }
    sideNav.replaceChildren(...children);
  };

  renderNav();
  // 初期 detail
  renderDetail(groups[0]!.items[0]!);

  const body = el('div', {
    style: 'display:flex;height:min(560px,70vh);width:min(820px,90vw);margin:0;overflow:hidden;border-radius:var(--r-2)',
  }, [sideNav, detailPane]);

  openModal(getRoot(), {
    title: '⚙ 設定',
    body,
    size: 'lg',
    primaryLabel: '閉じる',
    onPrimary: async () => { /* close only */ },
  });
}
