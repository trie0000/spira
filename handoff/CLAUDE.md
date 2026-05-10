# Spira — Claude Code instructions

> このファイルはプロジェクトルートに `CLAUDE.md` として配置すると、Claude Code が毎セッション自動で読みます。

## プロジェクト概要

Spira は SharePoint 上で動く **メール起票型チケット管理システム** (Zendesk 代替) です。

- ブックマークレットとして起動 → `<body>` にフルスクリーン overlay を注入
- SharePoint REST API で SP リスト (`Tickets` / `Comments` / 受信メール) を読み書き
- Graph API・外部 SaaS は **使えない** M365 制約環境向け
- 複数ユーザが同じチケットリストを共有
- 受信メールから起票 / 対応 / 内部メモを残す
- メール送受信は Outlook 側で実施 (Spira はチケット管理と過去メール参照に専念)

## 技術スタック

- **TypeScript (Vanilla)** — React/Vue 等は使わない
- バンドラ: Vite または esbuild (お任せ)
- 単一 JS bundle として bookmarklet から読み込む
- スタイル: 単一 CSS ファイル (`src/styles/app.css`)

## 設計仕様の優先順位

1. `Spira Design Spec.md` — **正典**。値・命名・構造はここに従う
2. `Spira Wireframes.html` — レイアウト/フローの参考。ピクセル単位ではない
3. `tokens.css` — CSS 変数の即利用可能版
4. ユーザの追加指示 — 上記とコンフリクトする場合は確認してから採用

## 必ず守ること

- **クラス名はすべて `spira-` prefix** (SP ホストへの CSS 漏れ防止)
- すべての要素は `.spira-root` 配下に配置
- フォントは Meiryo を最優先 (フォールバックは Spec §2.2 のスタックに従う)
- 角丸は `--r-1..4` (2/4/6/8px) のみ — 自由値禁止
- スペーシングは 4px 基準のスケール (`--s-1..10`) のみ
- シャドウは warm rgba(42,42,38,...) 系 — 青みなし、グラデーション禁止
- アクセント色は moss green `#7a8a78` のみ。input の focus には使わない (subtle focus 維持)
- コミットは MVP の各画面単位で

## 禁止事項

- グラデーション背景
- ネオモーフィズム
- 青系 box-shadow
- 絵文字をブランド要素として使う (本文中の例示としてはOK)
- 自由なフォント追加 (Spec §2.2 以外禁止)
- 自由な color hex 追加 (token を経由しない直書き禁止)
- React / Vue / jQuery / lodash 等の依存追加

## 実装フェーズ

### Phase 1: MVP (これを最初に完成させる)
- [ ] プロジェクトスキャフォールド + tokens.css 取込
- [ ] Shell (Shell A: classic sidebar) — `src/views/shell.ts`
- [ ] Ticket list (List A: dense table)
- [ ] Ticket detail (Detail B: right-rail properties)
- [ ] Inbox (Inbox A: list + per-row actions)
- [ ] 3 modals (新規起票 / 紐付け / 同期)
- [ ] toast / empty / loading / error 状態
- [ ] light theme のみ
- [ ] SP REST API クライアント (`src/api/sp.ts`)
- [ ] bookmarklet ローダ

### Phase 2 (MVP 確定後)
- [ ] dark theme (`data-theme="dark"`)
- [ ] ⌘K クイック切替
- [ ] フィルタ saved views
- [ ] キーボードショートカット (Spec §6.6)

### Phase 3
- [ ] kanban / card view 切替
- [ ] アクティビティタイムライン
- [ ] テンプレート返信

## ワークフロー

1. 新機能は **Spec を読む → 関連コンポーネントを確認 → 実装** の順
2. Spec にない判断が必要なときは **ユーザに確認 → 確定後 Spec を更新 → 実装**
3. Wireframes との差異が必要なときは Wireframes ではなく Spec を信頼
4. テスト: 主要フロー (起票 / 紐付け / メモ追加 / 同期) は手動シナリオを README に記載

## 参考: n365 (Shapion)

ローカルパス `/Users/a21/mytools/n365` に同トーンの先行実装あり。
特に `src/styles/app.css` は CSS パターンの参考になる。ただし **コピーではなく参照** のこと。

## 質問・確認の出し方

不明点はまとめて bullet list で出してから着手すること。1 ファイル書いては聞く、を避ける。
