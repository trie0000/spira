# Spira — Design Spec (handoff to Claude Code)

> M365 / SharePoint 上で動くメール起票型チケット管理。ブックマークレットで `<body>` に注入される overlay。
> n365 (Shapion) と同じトーン&マナーを踏襲。namespace prefix `spira-` 必須。

---

## 0. ファイル構成 (推奨)

```
spira/
├── index.html                  # エントリ (bookmarklet が読む)
├── src/
│   ├── styles/
│   │   └── app.css             # 全 CSS (token + component)
│   ├── icons.ts                # SVG アイコン定義 (Feather 風)
│   ├── api/
│   │   └── sp.ts               # SharePoint REST ラッパ
│   ├── views/
│   │   ├── shell.ts            # topbar + sidebar
│   │   ├── ticketList.ts       # 02 一覧
│   │   ├── ticketDetail.ts     # 03 詳細
│   │   └── inbox.ts            # 04 受信メール
│   ├── components/
│   │   ├── button.ts
│   │   ├── badge.ts
│   │   ├── modal.ts
│   │   ├── menu.ts
│   │   └── toast.ts
│   └── main.ts                 # bootstrap (root mount + theme + sync)
└── README.md
```

- フレームワーク不要 (Vanilla TS)。React 等の依存は禁止。
- 単一 bundle に成果物を出して bookmarklet から読み込む想定。

---

## 1. Namespace & 注入戦略

```
.spira-root { /* ここから配下のみが Spira の CSS を受ける */ }
```

- 全要素を `.spira-root` でラップ。CSS は `.spira-root xxx` の形で書き、SP ホスト側へ漏れない。
- すべてのクラス名は `spira-` prefix。
- フォーム要素には `all: revert` か明示プロパティで `box-sizing` などを再設定。
- SP ホストの z-index 最大想定で `.spira-root { z-index: 2147483600 }`。

```html
<div class="spira-root" data-theme="light">
  <div class="spira-overlay">         <!-- 半透明背景 -->
    <div class="spira-shell">          <!-- topbar + body -->
      <header class="spira-topbar">…</header>
      <div class="spira-body">
        <aside class="spira-side">…</aside>
        <main class="spira-main">…</main>
      </div>
    </div>
  </div>
</div>
```

---

## 2. デザイントークン (CSS 変数)

`.spira-root` に直接付与。`data-theme="dark"` でダーク上書き。

### 2.1 Color

```css
.spira-root {
  /* text */
  --ink:           #2a2a26;
  --ink-3:         #7a766c;
  --ink-4:         #a8a39a;

  /* surface */
  --paper:         #fafaf7;
  --paper-2:       #f3f1ea;
  --paper-2-strong:#ece8de;
  --paper-3:       #e8e4d8;

  /* line */
  --line:          rgba(42, 42, 38, 0.12);
  --line-strong:   rgba(42, 42, 38, 0.18);

  /* accent — moss green (n365 と同一) */
  --accent:        #7a8a78;
  --accent-soft:   rgba(122, 138, 120, 0.18);
  --accent-strong: #5e6f5c;

  /* status */
  --danger:        #b8534a;
  --warn:          #c47f1c;
  --ok:            #2f6f5e;
  --hl:            rgba(196, 174, 96, 0.35);
}

.spira-root[data-theme="dark"] {
  --ink:        #e8e4d8;
  --ink-3:      #a8a39a;
  --ink-4:      #7a766c;
  --paper:      #1d1b18;
  --paper-2:    #25231f;
  --paper-2-strong: #2c2a25;
  --paper-3:    #3a3731;
  --line:       rgba(232, 228, 216, 0.14);
  --line-strong:rgba(232, 228, 216, 0.22);
}
```

### 2.2 Type

```css
--font-sans: "Meiryo", "メイリオ", "Hiragino Sans", "Yu Gothic UI",
             -apple-system, "Segoe UI", system-ui, sans-serif;
--font-mono: ui-monospace, "Cascadia Mono", "Consolas", monospace;

/* sizes (px) */
--fs-xs: 11; --fs-sm: 12; --fs-md: 13; --fs-base: 15; --fs-lg: 16;
--fs-xl: 18; --fs-h3: 22; --fs-h2: 28; --fs-h1: 36;

/* line-height */
--lh-base: 1.75;
--lh-tight: 1.35;
```

### 2.3 Spacing (4px base)

```
--s-1: 4   --s-2: 6   --s-3: 8   --s-4: 10  --s-5: 12
--s-6: 14  --s-7: 18  --s-8: 22  --s-9: 28  --s-10: 40
```

### 2.4 Radius

```
--r-1: 2   --r-2: 4   --r-3: 6   --r-4: 8
```

### 2.5 Shadow (青みなし · warm rgba)

```
--shadow-flyout: 0 12px 30px rgba(42,42,38,.14);
--shadow-panel:  0 8px 20px rgba(42,42,38,.10);
--shadow-modal:  0 0 0 1px rgba(42,42,38,.06),
                 0 4px 12px rgba(42,42,38,.10),
                 0 16px 40px rgba(42,42,38,.18);
```

---

## 3. レイアウト (採用案)

ワイヤフレームから以下の組み合わせを推奨。気に入らなければユーザに確認。

| Screen | 採用案 | 備考 |
|---|---|---|
| Shell | **A: Classic sidebar** | 200px サイドバー + 36px トップバー |
| Ticket list | **A: Dense table** をデフォルト | カード/カンバンは将来オプション |
| Ticket detail | **B: Right-rail properties** | プロパティ常時可視 |
| Inbox | **A: List + per-row actions** | 単発トリアージ向け |

### 3.1 Shell (`spira-shell`)

- Topbar: 高さ **44px**, padding `0 var(--s-7)`, `border-bottom: 1px solid var(--line)`
  - 左: ロゴ「Spira」(moss dot + 太字), ブレッドクラム
  - 右: ユーザ名 / 同期 (アイコン, アニメーション可) / 設定 / テーマ切替 / 閉じる(×)
- Sidebar: 幅 **200px**, padding `var(--s-5) var(--s-3)`, `border-right: 1px solid var(--line)`
  - グループ見出し: `text-transform: uppercase; font-size: 11px; color: var(--ink-3); letter-spacing: .08em`
  - ナビ項目: 高さ ~30px, hover で `paper-2` 背景, **active は `accent-soft` 背景 + 左 2px `accent` ボーダー + `accent-strong` 文字**
  - 下部固定の「＋ 新規チケット」ボタン (primary, accent fill)
- Main: `flex: 1; min-width: 0`, 内部に toolbar + content

### 3.2 Ticket list

- 上部 toolbar (高さ 38px): フィルタチップ群 / ソート / 検索ボックス (右寄せ) / 同期
- Table: 列 `[#, Title, Status, 担当, 優, 期限, 更新]`
  - `th`: `font-weight: 400; color: var(--ink-3); font-size: 11px; text-transform: uppercase`
  - `tr`: 下線 1px `paper-3`, hover で `paper-2`
  - 期限超過: 期限セルのみ `color: var(--danger)` (option 1 採用)
  - 優先度: High = 赤ドット, Medium = warn ドット, Low = なし

### 3.3 Ticket detail (B: right-rail)

- 左ペイン (flex:1): ヘッダ (id + title) → スレッド → 内部メモ入力
- 右ペイン (固定 320px): プロパティテーブル + アクションボタン
- スレッド時系列: **古→新** (メールクライアント風)
- 受信コメント (`spira-th-card--received`): `paper-2` 背景 + 封筒アイコン
- 内部メモ (`spira-th-card--note`): `paper` 背景 + 左 3px `warn` ボーダー + メモアイコン (黄色付箋風)

### 3.4 Inbox (未処理メール)

- リスト: 件名 / 送信者 / 受信日時 / 「＋ 起票」「⌬ 紐付け」ボタン
- 0 件 → empty state (「未処理メールはありません」+ 同期ボタン)
- キーボード: ↑↓ で行移動, `Enter` で起票モーダル, `L` で紐付けモーダル

---

## 4. コンポーネント仕様

### 4.1 Button (`spira-btn`)

```
height: 34px;
padding: 0 var(--s-7);   /* 0 18px */
border-radius: var(--r-2);
font-size: var(--fs-md);
border: 1px solid var(--line-strong);
```

| Variant | クラス | 見た目 |
|---|---|---|
| primary | `spira-btn--primary` | `bg: var(--accent); color: #fff; border: var(--accent)` |
| dark | `spira-btn--dark` | `bg: var(--ink); color: var(--paper)` (取消／削除以外で目立たせたい時) |
| secondary | `spira-btn--secondary` | `bg: var(--paper-2); color: var(--ink)` |
| ghost | `spira-btn--ghost` | `bg: transparent; border: 1px dashed var(--line-strong)` |
| danger | `spira-btn--danger` | `bg: transparent; border-color: var(--danger); color: var(--danger)` |

Hover: `filter: brightness(.96)` または `paper-2` 系へ。focus は `outline: 2px solid var(--accent-soft)`。

### 4.2 Input (`spira-input`)

- 既定: `border: 1px solid transparent; background: transparent`
- hover: `background: var(--paper-2)`
- focus: `background: var(--paper); border: 1px solid var(--line-strong)` — **アクセント色は使わない (subtle focus)**
- placeholder: `color: var(--ink-4)`

### 4.3 Badge (`spira-badge`)

`display: inline-flex; padding: 2px 8px; border-radius: 99px; border: 1px solid; font-size: 12px; line-height: 1`

| Status | 見た目 |
|---|---|
| 新規 | `spira-badge--fill` → `bg: var(--accent); color: #fff; border: var(--accent)` |
| 対応中 | `spira-badge` → `bg: var(--paper); border: var(--line-strong); color: var(--ink)` |
| 確認待ち | `spira-badge--warn` → `bg: rgba(196,127,28,.14); border: var(--warn); color: #5d3d0c` |
| 完了 | `spira-badge--ok` → `bg: rgba(47,111,94,.12); border: var(--ok); color: var(--ok)` |
| 期限超過 | `spira-badge--danger` |

### 4.4 Modal (`spira-modal`)

```
backdrop: rgba(15,15,15,.45) + backdrop-filter: blur(2px)
box: bg var(--paper); border 1px var(--line-strong); radius var(--r-3)
shadow: var(--shadow-modal)
max-width: 520–760px; padding: var(--s-7)
```

- Esc / backdrop click = キャンセル
- Enter = primary
- 開いたら最初の input に focus

### 4.5 Menu / flyout (`spira-menu`)

```
bg: var(--paper); border: 1px var(--paper-3); radius: var(--r-2);
shadow: var(--shadow-flyout); padding: var(--s-1)
item: padding 5px 8px; radius var(--r-2); hover bg paper-2
```

### 4.6 List row (`spira-tk-row`)

- 下線 1px `paper-3`
- hover: `paper-2`
- active (選択中): 左 2px `accent` ボーダー + 微弱 `accent-soft` 背景

### 4.7 Toast (`spira-toast`)

- 位置: 右上 (top: var(--s-7); right: var(--s-7))
- アニメ: `transform: translateY(-8px) → 0; opacity 0 → 1; 200ms ease-out` (banner-in)
- 自動 dismiss: 4 秒 (失敗トーストは手動 dismiss)

### 4.8 Avatar

- 22 × 22 / 28 × 28
- `border-radius: 50%; bg: var(--accent); color: #fff` イニシャル表示
- 未割当: `border: 1px dashed var(--line-strong); bg: transparent` の空丸

### 4.9 Icon

- Feather 風 SVG、24×24 viewBox、`stroke-width: 1.7–2`、`stroke: currentColor; fill: none`
- 必要セット: `mail` `note` `gear` `sync` `x` `chevron-down` `search` `plus` `link` `copy` `external` `filter` `sort` `inbox` `clock` `user` `user-plus` `check` `alert`

---

## 5. クラス命名一覧

```
.spira-root                       /* host overlay */
.spira-overlay                    /* fullscreen black backdrop */
.spira-shell                      /* topbar + body */
.spira-topbar
.spira-side
.spira-main
.spira-toolbar                    /* main 内のサブツールバー */

.spira-btn
.spira-btn--primary | --dark | --secondary | --ghost | --danger
.spira-input
.spira-input--inline              /* タイトル等のインライン編集 */
.spira-badge
.spira-badge--fill | --ok | --warn | --danger | --acc

.spira-tk-row                     /* list 行 */
.spira-tk-table                   /* dense table */
.spira-tk-card                    /* card variant */
.spira-tk-detail                  /* detail page wrapper */
.spira-tk-prop                    /* property table (dl) */
.spira-tk-id                      /* #042 表示 */

.spira-th-list                    /* スレッド ul */
.spira-th-item
.spira-th-card
.spira-th-card--received
.spira-th-card--note

.spira-modal                      /* モーダル box */
.spira-modal-backdrop
.spira-toast
.spira-menu
.spira-menu-item
.spira-menu-divider

.spira-empty                      /* empty state */
.spira-skeleton                   /* loading 用 */
.spira-error-banner               /* SP API 失敗時 */
```

---

## 6. インタラクション仕様

### 6.1 起動

- bookmarklet 実行 → `.spira-root` を `body` に append → 同期 (受信メール取得) → 一覧描画

### 6.2 同期 (`sync`)

- topbar の同期アイコンを 360° 回転 (CSS animation `linear infinite`)
- 完了時:
  - 成功: toast 「同期完了 · N 件処理 (自動 X 件 / 未処理 Y 件)」
  - 失敗: error banner 永続表示 (上部, danger 色)、再試行ボタン付き

### 6.3 起票フロー

1. Inbox 行で「＋ 起票」 → `New Ticket Modal` 開く (元メールプレビュー + フォーム)
2. 確定 → SP `Tickets` リストに POST → `Comments` に元メール push (received) → トースト → 一覧へ反映

### 6.4 紐付けフロー

1. Inbox 行で「⌬ 紐付け」 → `Link Modal` 開く
2. `#001` または件名で検索 → 結果リストから選択 → 確定 → 元メールを既存チケットの `Comments` に append

### 6.5 内部メモ追加

- 詳細画面下の textarea にフォーカス
- `Cmd/Ctrl + Enter` で保存
- 保存後 thread 末尾に warn 左ボーダー付きカードとして即時追加 (楽観更新 → SP 失敗時はロールバック + toast)

### 6.6 キーボード

| Key | Action |
|---|---|
| `⌘K` / `Ctrl+K` | 検索 / クイック切替 (Phase 2) |
| `N` | 新規チケット |
| `↑ ↓` | リスト行移動 |
| `Enter` | 選択行を開く |
| `Esc` | モーダル閉じる / overlay 全体閉じる |
| `T` | テーマ切替 |

### 6.7 状態フィードバック

- **Loading**: 一覧は skeleton 行 (paper-2 角丸の灰色矩形), 詳細はスケルトンスレッド
- **Empty**: アイコンレス, ハンドリング済みメッセージ + CTA
- **Error**: 上部 banner (danger 背景 14% alpha + 下線 danger), データは可能な限り保持

---

## 7. データモデル (UI 観点)

UI が扱う最小フィールド。詳細スキーマは Notion 仕様参照。

### 7.1 Ticket

```ts
interface Ticket {
  id: number;                // #042 のような連番 (SP の ID と別管理 or 同一)
  title: string;
  status: '新規' | '対応中' | '確認待ち' | '完了';
  assignee?: string;         // M365 user displayName
  priority: 'High' | 'Medium' | 'Low';
  dueDate?: string;          // ISO date
  createdAt: string;         // ISO datetime
  updatedAt: string;
  fromEmail?: string;        // 起票元メールアドレス
  owaUrl?: string;           // 元メールへの OWA リンク
}
```

### 7.2 Comment

```ts
interface Comment {
  id: number;
  ticketId: number;
  type: 'received' | 'note';
  author: string;
  body: string;              // plain text or limited HTML
  receivedAt?: string;       // received のみ
  createdAt: string;
}
```

### 7.3 InboxMail (未処理)

```ts
interface InboxMail {
  id: number;
  subject: string;
  from: string;
  receivedAt: string;
  bodyPreview: string;
  ticketId?: number;         // 紐付け済みなら入る
  status: 'unprocessed' | 'linked' | 'created';
}
```

---

## 8. アクセシビリティ最低限

- すべての icon-only ボタンに `aria-label`
- modal: `role="dialog"` `aria-modal="true"` `aria-labelledby`
- focus trap (modal 内)
- `prefers-reduced-motion` で sync アニメ・toast スライドを停止
- コントラスト: ink on paper ≥ 4.5:1 (確認済み)

---

## 9. テーマ切替

```ts
function setTheme(t: 'light' | 'dark') {
  document.querySelector('.spira-root')!.setAttribute('data-theme', t);
  localStorage.setItem('spira:theme', t);
}
```

起動時 `localStorage` → なければ `prefers-color-scheme`。

---

## 10. 参考実装

- ワイヤフレーム: `Spira Wireframes.html` (本プロジェクト)
- n365 (Shapion): `/Users/a21/mytools/n365`
  - 全 CSS: `src/styles/app.css`
  - アイコン: `src/icons.ts`
  - 主要セクション行は元プロンプト参照

## 11. Phase 分け推奨

| Phase | 内容 |
|---|---|
| **MVP** | Shell A + Ticket list A + Ticket detail B + Inbox A + 3 modals + light theme |
| **Phase 2** | dark theme, ⌘K, kanban view, saved views, keyboard shortcut全般 |
| **Phase 3** | カード/カンバンビュー切替, アクティビティタイムライン, テンプレート返信 |

---

> ※ 不明点が出たら `Spira Wireframes.html` の `Open questions` パネルを優先確認のこと。
