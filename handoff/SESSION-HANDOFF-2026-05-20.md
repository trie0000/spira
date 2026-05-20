# Spira — セッション引き継ぎ (2026-05-20)

> このドキュメントは別セッションで Spira の作業を続ける Claude / 開発者に向けた **引き継ぎ書**。
> Notion 側の包括的な記録は **[🛠️ 実装記録 — 2026-05-20](https://www.notion.so/3666a1cf2b798185b405f695b2ce0396)** に。
> ベースの設計仕様 / コーディング規約は同フォルダ内の `CLAUDE.md` / `Spira Design Spec.md` を参照。

---

## 0. クイック サマリー

- **状態**: Phase 3 進行中 (Phase 1/2 = MVP は 2026-05-17 時点で完了済み)
- **最新 commit**: `35a2dfc` (`origin/main` に push 済み)
- **直近のテーマ**: 「申請者へのメール返信を Spira から完結させる」流れの完成。Outlook クライアントを介した正規 Reply + 共通 ML 設定 + ヘッダ UI 整理
- **ブランチ**: `main` 1 本のみ。worktree は使っていない
- **作業ディレクトリ**: `/Users/a21/mytools/Spira`
- **リモート**: `https://github.com/trie0000/spira`

---

## 1. 全体アーキテクチャ (現在)

```
                    operator の PC (Windows / Mac)
┌────────────────────────────────────────────────────────────────┐
│                                                                │
│   ブラウザ                       PowerShell (常駐)              │
│   ┌──────────────────┐          ┌───────────────────────────┐  │
│   │ Spira            │  HTTP    │ spira-ai-relay.ps1        │  │
│   │ (bookmarklet)    │ ───────► │  - /spira/health          │  │
│   │ SharePoint 上で  │ JSON     │  - /spira/outlook/reply   │  │
│   │ 動作             │ UTF-8    │  - /spira/outlook/new     │  │
│   └──┬───────────────┘          │  - /openai/* (AI 中継)    │  │
│      │                          └────┬──────────────────────┘  │
│      │ REST                          │ COM                     │
│      │ same-origin                   │                         │
│      ▼                               ▼                         │
│   ┌──────────────┐               ┌──────────────────────────┐  │
│   │ SharePoint   │               │ Outlook デスクトップ     │  │
│   │ (M365)       │               │  - 受信箱 (PA 経由)      │  │
│   │              │               │  - 下書き表示            │  │
│   │ Tickets      │               │  - operator が送信      │  │
│   │ Comments     │               └──────────────────────────┘  │
│   │ InboxMails   │                                              │
│   │ TeamsPostReq │   ┌──────────────────────────┐               │
│   │ AuditLog     │ ◄─┤ Power Automate (Cloud)   │               │
│   │ SpiraSetting │   │  ① メール取込            │               │
│   └──────────────┘   │  ② Teams スレッド作成    │               │
│                      │  ③ Forms 取込            │               │
│                      │  ④ Teams 返信同期        │               │
│                      └──────────────────────────┘               │
└────────────────────────────────────────────────────────────────┘
```

### 3 つのコンポーネント

1. **Spira (TypeScript bookmarklet)** — UI 全部、SP REST 直叩き
2. **Power Automate (4 フロー、Standard tier のみ)** — メール / Forms / Teams の取込と Teams 投稿
3. **spira-ai-relay.ps1 (PowerShell 5.1)** — operator の PC で常駐、Outlook COM 操作 + 社内 AI ゲートウェイ中継 (Python 不要)

---

## 2. 最近の主要機能 (2026-05-17 → 2026-05-20)

詳細は Notion の **[🛠️ 実装記録 — 2026-05-20](https://www.notion.so/3666a1cf2b798185b405f695b2ce0396)** を読むこと。要旨だけ:

| 項目 | 概要 |
|---|---|
| **📧 返信メール作成** | 「返信メール作成」ボタン → モーダルで件名/本文/Cc 編集 → ローカル中継経由で Outlook 下書きを開く。reply/new の 2 モード自動判定。`.Send()` は呼ばず operator が手動送信 |
| **共通 ML (Cc + Reply-To)** | 設定ハブの「メール返信 — 共通 ML」で登録した ML が、返信モーダル開封時に Cc に自動プリフィル + Outlook 下書きの ReplyRecipientNames にもセット |
| **対応経緯の二分割** | 「内部対応経緯」「外部対応経緯」の 2 カラム並列表示 (外部=左/内部=右)。並列/単独/マージの 4 モード切替 |
| **kebab メニュー** | チケット詳細ヘッダの「外部スレッド起票」「内部スレッド起票」「エクスポート」「プロパティ」「Forms 回答一覧」を ⋯ メニューに集約 (可視ボタン = AI / 件名コピー / 返信 / ⋯ / 削除) |
| **タグ機能 (厳格辞書)** | 自由入力ではなく admin 登録の辞書から選ぶ。色付き。名前変更/削除は bulk migration |
| **設定ハブ統合** | 左サイドナビ + 右パネル inline 展開、共通保存ボタン 1 つ |
| **エクスポート** | Markdown / HTML / PDF / JSON、対象 (内部/外部/メモ) と レイアウト (併記/マージ) 選択可 |
| **ダッシュボード** | ステータス/影響度/部門集計 + 滞留中チケット + 直近 7 日アクティビティ |
| **検索/フィルタ強化** | 150ms debounce + silent setFilter + in-place rerender (ちらつき解消)。検索対象を一覧の全列に拡張。日付 from-to レンジ追加 |
| **PA フロー④ (Teams 返信同期)** | 統合トリガー (Graph 変更通知形式) + GetMessage + 条件で実装。ヘルプは fx (式) ベースに全面書き換え (動的コンテンツ依存撤廃) |
| **inbox の運用改善** | 「管理外」(reason 記録) + 物理削除 + 削除済みチケットの thread 宛 reply は自動 purge |
| **OWA 関連の完全撤去** | `utils/owa.ts` 削除 + OWA Compose fallback も廃止。全 Outlook 操作は relay 経由 |

---

## 3. 重要なファイル / ディレクトリ案内

```
Spira/
├── src/
│   ├── api/
│   │   ├── sp.ts                 # SharePoint REST 実装 (本番)
│   │   ├── mock.ts               # メモリ実装 (dev / ?mock=1)
│   │   ├── repo.ts               # Repository インタフェース
│   │   ├── aiClaude.ts / aiCorp.ts / aiSettings.ts
│   │   └── sampleInbox.ts
│   ├── lib/
│   │   ├── note-editor/          # Notion 風内部メモエディタ
│   │   ├── audit.ts
│   │   ├── aiContext.ts
│   │   ├── eml-parser.ts         # .eml/.msg ドロップ解析
│   │   └── teams-paste.ts        # Teams 右クリックコピー解析
│   ├── utils/
│   │   ├── spiraRelay.ts         # 🆕 ローカル中継 HTTP クライアント
│   │   ├── mailSettings.ts       # 🆕 共通 ML 設定
│   │   ├── tagDictionary.ts      # タグ辞書
│   │   ├── optionLists.ts        # 選択肢 (Status/Priority/Department/Category)
│   │   ├── teamsChannels.ts      # Teams チャネル設定
│   │   ├── formsSettings.ts      # Forms 回答一覧 URL
│   │   ├── members.ts            # 内部メンバー判定 (nameVariants)
│   │   ├── spSites.ts            # SP サイト選択
│   │   └── ...
│   ├── views/
│   │   ├── ticketDetail.ts       # チケット詳細 (返信モーダル等)
│   │   ├── ticketList.ts         # 一覧 + 検索/フィルタ
│   │   ├── ticketProperties.ts
│   │   ├── ticketExportModal.ts
│   │   ├── inbox.ts              # 受信箱
│   │   ├── dashboard.ts
│   │   ├── help.ts               # オンラインヘルプ View
│   │   ├── aboutModal.ts         # Spira について
│   │   ├── aiChat.ts             # AI チャット右ペイン
│   │   ├── settingsModal.ts      # 🆕 設定ハブ
│   │   └── shell.ts              # 全体 shell (sidebar / topbar / PA ヘルプ等)
│   ├── components/
│   │   ├── modal.ts              # モーダル基盤 (focus trap / Esc 処理)
│   │   ├── toast.ts
│   │   └── datetime.ts
│   └── main.ts                   # bootstrap
│
├── scripts/                      # PowerShell ローカル中継
│   ├── spira-ai-relay.ps1        # 🆕 AI + Outlook 兼用
│   ├── spira-ai-relay.bat        # Windows 起動用 wrapper
│   ├── spira-ai-relay.env.example
│   └── README.md                 # 配布/運用手順
│
├── dist/
│   ├── spira.js
│   ├── index.html
│   └── install.html              # bookmarklet inlined (operator 配布物)
│
├── docs/
│   └── FEATURE-REQUIREMENTS.md
│
├── handoff/                      # ★ あなたが今読んでいるディレクトリ
│   ├── CLAUDE.md                 # Claude Code 用ルール (毎セッション読まれる)
│   ├── README.md
│   ├── Spira Design Spec.md      # デザイン正典
│   ├── SESSION-HANDOFF-2026-05-20.md   # 🆕 このファイル
│   ├── Spira Wireframes.html
│   └── tokens.css
│
├── build.js                      # esbuild + minify + install.html 生成
└── package.json
```

---

## 4. 運用ルール (この順守を期待)

- **TypeScript Vanilla** (React / Vue / jQuery / lodash 等は導入しない)
- **クラス名は必ず `spira-` prefix** (CSS 漏れ防止)
- **角丸 / スペーシング / 色** はすべて token (CSS 変数) 経由。直書き値は禁止
- **コミットはタスクごと** (`git push` まで含めて 1 単位)
- **コミットメッセージは日本語**、`Co-Authored-By:` トレーラを付ける
- **テスト無し**。手動確認 + `npm run build` (esbuild) と `npm run type-check` でガード
- **絵文字は本文/UI 内で OK だがブランド要素には使わない**

### Git の流儀

- 直接 `main` に push (worktree も別ブランチも基本使わない)
- `npm run build` 後に `dist/` も含めてコミット (bookmarklet 配布物のため)
- コミットメッセージのフォーマット:

```
<件名 (日本語 / 50 字程度)>

<本文 (背景 / 修正内容 / なぜ 等を多めに)>

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## 5. ローカル開発の起動

```bash
cd /Users/a21/mytools/Spira

# 通常ビルド (minify ON)
npm run build

# 型チェックだけ (型エラーは数件 pre-existing あり、無視可)
npm run type-check

# dev server (esbuild watch + 静的サーバ)
npm run dev
```

ローカル動作確認は `dev/index.html` を `?mock=1` 付きで開くと in-memory mock データで起動可。

---

## 6. PowerShell リレー (operator 配布)

operator の Windows PC で常駐させる:

1. `scripts/` ごと `C:\Tools\spira-relay\` 等に配置
2. `spira-ai-relay.env.example` を `spira-ai-relay.env` にコピー + 編集
   - **AI 中継も使うなら** `SPIRA_AI_TARGET` / `SPIRA_AI_PROXY` を設定
   - **Outlook 中継だけなら** これらは空でも OK (起動可能)
3. `spira-ai-relay.bat` をダブルクリック (または タスクスケジューラで logon 起動)
4. http://localhost:18080 で待受

### relay の役割

- **AI 中継** (`/openai/*`) — Spira → 社内 AI ゲートウェイへの forwarding (オンプレ proxy 経由可能、SSE ストリーミング対応)
- **Outlook reply 中継** (`POST /spira/outlook/reply`) — `sentAtIso + fromEmail` で operator の Outlook 内の元メールを検索 → `.Reply()` → `.Display()`
- **Outlook new 中継** (`POST /spira/outlook/new`) — 新規 MailItem 作成 → `.Display()`
- **死活確認** (`GET /spira/health`)

### 重要: `.Send()` は呼ばない

設計上、relay は下書きを Outlook 画面に表示するだけ。誤送信防止 + operator の Outlook 標準の確認フロー + 個人 Sent Items への記録のため、この方針は変更しないこと。

---

## 7. 関係する SharePoint リスト

- **Tickets** — チケット本体 (Tags / source / threadKind 等の列含む)
- **Comments** — 履歴 (type='received'/'note'、source / threadKind / internetMessageId)
- **InboxMails** — PA 経由の受信メール一時格納 (Spira が syncInbox で消化)
- **TeamsPostRequests** — Spira → Teams 投稿キュー (PA フロー②がこれを拾う)
- **SpiraSettings** — Key/Value 共通設定 (タグ辞書 / Teams チャネル / Forms URL / 共通 ML / option lists)
- **AuditLog** — 監査ログ (保持期間付き、24 時間に 1 回クリーンアップ)
- **SpiraAttachments** — メモ添付ファイル

`ensureLists()` (bootstrap) が起動時に全リストの存在 / 列を保証する。

---

## 8. 現在の制約 / 未解決

### 既知の運用前提
- **Windows + Outlook デスクトップ** が relay 利用に必須 (Mac の AppleScript 対応は未実装)
- **PA Standard tier** のみ。Premium / Graph API / Power Apps は使えない前提
- 共有メールボックスは使えず、operator の **個人ボックスで PA フロー①** が動く
- Power Apps / 顧客向けポータルなし。申請者は普通のメール + Teams (ゲスト可)

### 撤回した機能
- **Teams スレッド起票時のメンション機能** — PA Standard で実現するには複雑すぎてコスパが悪いと判断、撤回 (関連 commit: `05cc767`)。設定 / SP 列 / PA STEP 3a/3b/3c はすべて元に戻した

### 既知の pre-existing 型エラー
- `src/views/ticketDetail.ts` の SourceKind 型関連で警告数件 (機能には影響なし)
- `renderReceivedThread` 未使用 (dead code、将来削除予定)
- `src/api/mock.ts` の Ticket cast 警告数件

### Spira 制約上、難しいまま残っている課題
- 申請者側 UI (= 顧客向けポータル) — Power Pages なしでは作れない。Outlook 往復で運用
- Teams 個別チャネル での問い合わせ分離 — チャネル作成権限が無い環境では グループ チャット に逃げる必要 (今回は採用見送り、メール往復に統一)

---

## 9. PA フロー (現状の構成)

| # | 名称 | 必須 | 役割 |
|---|---|---|---|
| ① | メール取り込み | 必須 | Outlook 新着 (To/Cc に対応 ML) → InboxMails に行追加 |
| ② | Teams スレッド作成 | 任意 | TeamsPostRequests に行追加 → Teams 投稿 + Tickets に DeepLink 書き戻し |
| ③ | Forms 取り込み | 任意 | Forms 応答 → InboxMails (ConversationId = `forms-*`) |
| ④ | Teams 返信同期 | 任意 | 監視チャネルの返信 → InboxMails (ConversationId = `teams-*`) → Spira で auto-link |

ヘルプは Spira 内 **歯車 → ヘルプ (PA フロー作成手順)** に **fx (式) コード をコピペするだけで再現できる** 粒度で記載済み。詳細は `src/views/shell.ts` の `buildPaFlowsHelpBody`。

---

## 10. 次のセッションが「次に来そう」と予想する依頼

実装すれば運用がさらに楽になる順:

1. **送信記録を Spira に残す**: relay が draft 作成時に Spira 側にも「自分が送ったメッセージ」として外部対応経緯に仮カードを追加する案 (現状は送信したか曖昧)
2. **通知** (担当者割り当て / 新着 / 期限近接) — PA フロー追加 (SP リスト変更トリガー → Outlook 送信)
3. **テンプレ複数登録** (返信本文テンプレを選んで挿入)
4. **キーボード ショートカット** (`j/k` 行移動 / `Enter` 開く / `E` 編集 等)
5. **ナレッジベース連携** (FAQ リスト + 起票時の提案)
6. **Mac の Outlook 連携 (AppleScript)** — Mac 利用者がいれば
7. **モバイル対応** (縦持ち / 狭画面の最適化)

---

## 11. 困ったら見る場所

- **コードの設計意図**: ファイルの先頭コメント (ほぼすべてに「なぜこの実装か」が書いてある)
- **PA フロー**: Spira 内 歯車 → ヘルプ
- **オンラインヘルプ**: サイドバー「ヘルプ」アイコン
- **約束/タブー**: `handoff/CLAUDE.md`
- **デザイン正典**: `handoff/Spira Design Spec.md`
- **過去の実装記録**: Notion「🎯 Spira - プロジェクトHUB」配下
- **過去のコミット**: `git log --oneline` でだいたい雰囲気が掴める (日本語 commit message)

---

## 12. 連絡先 / 既存リソース

- **GitHub**: https://github.com/trie0000/spira
- **Notion HUB**: https://www.notion.so/35c6a1cf2b7981df941fd943d354ceef
- **Notion 実装記録 (最新)**: https://www.notion.so/3666a1cf2b798185b405f695b2ce0396
- **作業ディレクトリ**: `/Users/a21/mytools/Spira`

---

**最終更新**: 2026-05-20 (commit `35a2dfc` 時点)
**次セッション開始時の最初の確認**: `git pull && npm run build` でビルドが通ることを確認 → このドキュメント + `handoff/CLAUDE.md` を読み込む
