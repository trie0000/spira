# Spira 機能要件 (2026-05-14 時点)

レビュー時はこのドキュメントを「期待される挙動」の基準として使うこと。
実装が要件を満たしていない箇所、エッジケース未考慮、データ破壊リスク、
セキュリティ問題を中心に指摘してほしい。

---

## A. アーキテクチャ前提

- **環境制約**: M365 テナント内、Graph API / 外部 SaaS / 共有メールボックス 不可
- **構成**: SharePoint REST API (同一オリジン認証) + Power Automate 1 本 + ブックマークレット
- **データ ストア**: SP リスト 3 種 (`Tickets` / `Comments` / `InboxMails`) + ドキュメント ライブラリ 1 種 (`SpiraAttachments`)
- **メール送受信は Outlook 側 に完全委譲** — Spira は閲覧と紐付けのみ
- **モード**: SP 本番モード / mock モード (`?mock=1` または非 SP ホスト)

---

## B. チケット管理

### B-1. CRUD
- 新規起票: 受信メールから or 手動 (タイトル / ステータス / 優先度 / 担当者 / 期限)
- 編集: ステータス / 優先度 / 担当者 / 期限 / タイトル
- 削除: ソフトデリート (ゴミ箱) → ハード削除 (完全削除)
- ゴミ箱: 復元 / ハード削除 / 全削除

### B-2. ID 形式
- SP の自動採番 ID をそのまま使用 (`id: number`)
- 表示形式: `#NNNNN` (5 桁ゼロパディング固定)
- メール件名タグ: `[<prefix>#NNNNN]` 固定。prefix のみ ユーザ設定で可変 (英数字 + `_-`、最大 12 文字、空欄可)
- パース時はレガシー形式 `[CASE-NNN]` / `(#NNN)` / `<#NNN>` も受け付ける
- ヘルパ: `formatTicketTag(id)` / `formatTicketIdShort(id)` / `parseTicketTag(subject)` / `getTicketIdPrefix()` / `setTicketIdPrefix(prefix)` / `sanitizePrefix(input)` / `cleanSubjectCore(subject)` / `buildCopyableSubject(id, title)`

### B-3. チケット一覧画面 (`renderTicketList`)
- 列順: ☐ / # / Title / Status / 担当 / 優先度 / 期限 / **最終返信** / **滞留日** / **経過日** / 更新
- ソート可能: id / title / status / assignee / priority / due / updated
- 経過日: `createdAt` から現在までの日数。7 日以上で warn 色
- 滞留日: 最新の `received` コメントから現在までの日数。3 日以上で warn 色
- 最終返信: 最新 received コメントの `fromEmail` を `isInternalMember()` で内部/外部判定。バッジ表示
- データ取得: `listTickets()` + `Promise.all(tickets.map(t => listComments(t.id)))` で並列。N+1 だが小規模なので許容
- フィルター: ステータス / 優先度 / 担当者 / タイトル ID 検索
- 多選択: チェックボックス、選択中バッジ、一括ステータス変更可能 (?)

### B-4. チケット詳細画面 (`renderTicketDetail`)
- 2 ペイン: 左 = 受信メール スレッド、右 = 内部メモ
- ヘッダ: タブ ストリップ + 戻る / 件名コピー / OWA で返信 / 削除
- タブ ストリップ: 開いているチケットを切り替え (×で閉じる)
- メタ情報行: 起票日時 / 更新日時 / 起票元 / ID + タイトル / ステータス + 優先度 / 担当者 + 期限
- ステータス / 優先度: クリックでドロップダウン編集
- 担当者 / 期限: クリックで編集

### B-5. 件名コピー
- ボタン押下で `[<prefix>#NNNNN] <整形済みタイトル>` をクリップボードへ
- 整形: `cleanSubjectCore()` で先頭の `RE:` / `FW:` / `Fwd:` / `返信:` / `転送:` および leading `[...]` ブロック (ML 番号 / 旧チケットタグ等) を全部剥がす、繰り返し適用

### B-6. 重複起票防止
- 受信メールから「+ 起票」時、`onPrimary` の冒頭で `findDuplicateTicketForMail()` を実行
- 判定優先順位:
  1. `internetMessageId` 一致
  2. `fromEmail` AND (`sentAt` または `receivedAt`) 一致
- 重複検出時: toast 表示 + 該当チケット強制オープン + 当該 inbox 行を `auto-linked` 完了マーク
- 比較: N+1 (`listTickets()` × `listComments(id)` 全走査) だが submit 時のみ

---

## C. 受信メール (InboxMails)

### C-1. 取り込み (Power Automate)
- PA トリガ: `When a new email arrives (V3)` または共有メールボックス V2
- SP `InboxMails` リスト 1 行 = メール 1 通
- 列スキーマ (全 16 列):
  - `Title` (必須) / `Subject` / `BodyHtml` (NoteRich) / `BodyText` (Note) / `FromEmail` / `FromName`
  - `HasAttachments` / `ConversationId` / **`ReceivedAt`** / **`SentAt`** / `OwaLink` / `IsProcessed`
  - `TicketId` / `ProcessedAt` / `ProcessResult` (Choice: auto-linked/manual-linked/created) / `IsHidden` / `InternetMessageId`
- `OwaLink` は式: `concat('https://outlook.office.com/mail/inbox/id/', encodeUriComponent(triggerOutputs()?['body/Id']))`
- `SentAt` は式: `triggerOutputs()?['body/sentDateTime']` (動的コンテンツ「Sent Time」が出ない場合)
- `ReceivedAt` には `Received Time` (表示用)、`SentAt` に `Sent Time` (重複判定用)

### C-2. 受信メール一覧 / 詳細
- 件名 / 差出人 / 受信日時 / 添付 / OWA 検索 / プレビュー
- 「+ 起票」 / 「⌬ 紐付け」 / 「非表示」
- 件名内 `[<prefix>#NNNNN]` タグで既存チケットに自動紐付け (`syncInbox()`)
- `parseTicketTag()` がレガシー形式も受理

### C-3. 自動紐付け (syncInbox)
- 未処理の Inbox 行を走査
- 件名タグでチケット ID を抽出 → 該当チケットの `received` コメントに追加
- 重複防止: 既存コメントに同じ `internetMessageId` があればスキップ (実装確認要)
- マーク `IsProcessed=true`, `TicketId`, `ProcessResult=auto-linked`

---

## D. 内部メモ (Notion 風エディタ)

### D-1. パッケージ構造
- 場所: `src/lib/note-editor/` (独立パッケージ、外部依存ゼロ)
- ファイル: `editor.ts` / `markdown.ts` / `editor.css` / `index.ts` / `README.md`
- ホスト依存はコールバックで注入 (`onDirty` / `onSubmit` / `onCancel` / `onFileUpload` / `floatingContainer`)
- CSS: `--ne-*` 変数で外部からテーマ可能

### D-2. ブロック サポート (スラッシュ メニュー)
- 基本: テキスト / 見出し 1-3 / コールアウト (💡) / 引用
- リスト: 箇条書き / 番号付き / ToDo (チェックボックス、状態保存)
- メディア: 区切り線 / ファイル添付 (📎)
- コード: コードブロック
- データ: 表 (3x2 デフォルト、Tab/Enter ナビゲーション)
- Markdown ショートカット: `/##` `/-` `/[]` `/```` `/>` で項目フィルタ

### D-3. インライン書式
- 太字 / 斜体 / 取消線 / インラインコード (フローティング ツールバー、選択時表示)
- リンク / 画像 (base64 ペースト)
- インライン コードは赤字 (`#c7254e`)、コードブロック内は通常テキスト色

### D-4. 入力支援
- スラッシュ メニュー: `/` で起動。CJK 直後でも反応 (regex `(^|\s|[^\x00-\x7F])`)
- ブロック ドラッグ ハンドル: 左マージン、マウスホバーで表示 + caret 行追従
- ハンドルとエディタ間のギャップも hit zone に含める (見失わない)
- focus 時: 末尾が非空なら `<p><br></p>` を自動追加 + caret park。元々空行なら追加しない
- 未入力で blur → throwaway 空行を削除 (updatedAt 不変)
- 全テキスト削除後も `ensureNonEmpty()` で常に編集可能

### D-5. 自動保存
- カードに直接エディタ表示 (編集モード廃止)
- `onDirty` で 700ms デバウンス自動保存
- ステータス: `未保存` → `保存中…` → `保存済み`
- `Cmd/Ctrl+Enter` で即フラッシュ
- `beforeunload` で best-effort flush

### D-6. メモを追加ボタン
- ノート リスト下部の「+ メモを追加」ボタン
- クリック → 空 Comment 作成 (`content: '', isHtml: false`)
- 新カードのエディタに自動フォーカス (setTimeout 50ms)

### D-7. Markdown ラウンドトリップ
- 保存形式: Markdown (`isHtml: false`)
- ヘルパ: `htmlToMarkdown(html)` / `markdownToHtml(md)` / `ensureBlockWrapped(html)`
- 表は `<div class="ne-table-wrap"><table class="ne-table">...` ↔ GFM パイプ表
- callout は `<div class="ne-callout">` ↔ `> 💡 ...` (blockquote + 絵文字プレフィックス)
- ToDo は `<div class="ne-todo">` ↔ `- [x] ...` / `- [ ] ...`
- 受信時は SP NoteRich の HTML エンティティを `decodeSpEntities()` でデコード (絵文字 BMP 外 / `<` / `>` / `&` 対応)

### D-8. 自動 destroy / リーク防止
- `MutationObserver` で root が DOM から外れたら slash menu / floating toolbar / drag handle / selectionchange / document mousemove リスナーを自動 cleanup
- 「初回 connected 検出後の detach」のみ反応する edge-trigger
- `destroy()` を外部からも呼べる

---

## E. ファイル添付

### E-1. 配置
- SP ドキュメント ライブラリ `SpiraAttachments/` (BaseTemplate 101)
- サブフォルダ: `ticket-NNNNN/` (5 桁ゼロパディング)
- ファイル名: 元のファイル名 (NFC 正規化済み)、衝突時は ` (1)` / ` (2)` ... 自動 suffix

### E-2. 自動セットアップ
- `ensureLists()` が `SpiraAttachments` ライブラリを自動作成
- 各チケットのサブフォルダは初回アップロード時に `ensureAttachmentFolder()` が POST `/folders` で作成
- フォルダ存在確認は `GetFolderByServerRelativeUrl` の **payload の `Exists` フィールド**で判定 (HTTP 404 ではなく 200+`Exists:false` パターンに注意)

### E-3. 投入経路
- **D&D**: 画像は base64 インライン、それ以外は `onFileUpload` ホスト コールバック
- **ペースト**: 同上
- **スラッシュ メニュー** `📎 ファイル添付`: ネイティブ ファイル ピッカー → アップロード

### E-4. アップロード フロー
- 即座にプレースホルダ チップ挿入 (`<span class="ne-file ne-file--uploading">...アップロード中…</span>`)
- 完了 → 本物のチップ (`<a class="ne-file" href="..." target="_blank">`) と差し替え
- 失敗 → プレースホルダ削除 + ホスト側 toast
- アップロード中は `markDirty()` 呼ばない、完了時に呼ぶ

### E-5. チップ UI
- インライン ピル形状、`📊 📕 📝 📈 📦 📎` 拡張子別アイコン
- ホバーで `title` 「ダブルクリックで開く: <filename>」
- エディタ内: シングルクリック preventDefault、**ダブルクリック で `window.open(href, '_blank')`**
- 読み取り表示 (`.ne-prose`): アンカー既定動作 (シングルクリックでも開く)
- `download` 属性なし → Office Online / PDF ビューア / 必要時のみダウンロード

### E-6. Markdown ラウンドトリップ
- 保存: `[<icon> <filename>](url)` (例: `[📝 ねずこ.docx](https://...)`)
- 復元: リンク テキスト先頭の絵文字 (`📎/📊/📕/📝/📈/📦`) を検出 → `.ne-file` チップに昇格
- それ以外のリンクは普通の `<a>`

### E-7. 衝突回避 (`resolveNonCollidingName`)
- 同チケット内で同名: `report.xlsx` → `report (1).xlsx` → ... 最大 100 回試行
- 別チケット間: 別フォルダなので衝突なし

---

## F. 設定 (歯車メニュー)

### F-1. 表示項目
- モード ラベル (`sp` / `mock`)
- ビルド ID (クリックでクリップボード コピー)
- 内部メンバー設定 → モーダル
- チケット ID 形式 → モーダル (prefix 編集 + プレビュー)
- ヘルプ (PA フロー作成手順) → モーダル
- SP リストをリセット (中身全削除、List GUID 保持で PA フローを壊さない)

### F-2. ID 形式モーダル
- テキスト入力 1 個 (prefix、12 文字以内、英数+`_-`)
- ライブ プレビュー: `[<prefix>#00001]`
- 不正文字自動除去 (`sanitizePrefix()`)
- 保存 → `localStorage` に永続化

### F-3. ヘルプ モーダル (PA フロー手順)
- 5 セクション + InboxMails 列マッピング表 (16 列)
- `OwaLink` / `SentAt` は式タブから入力する旨を明示、コードブロックでコピペ可能
- トラブルシューティング項目を網羅
- モーダル本文は `user-select: text` で選択 / コピー可能

---

## G. ビルド / バージョン管理

- `build.js` が build ID を生成し esbuild の `define` で焼き込み
- 形式: `<version>-<gitsha>+ (ISO8601)` ※ uncommitted 変更がある場合 `+`
- 起動時 console と設定メニューに表示
- `dist/install.html` / `dist/index.html` / `dist/bookmarklet.txt` は git 追跡 (再配布用)

---

## H. 共通: セキュリティ / バリデーション

- HTML サニタイズ: `sanitizeMailHtml()` (メール表示用 厳しめ) / `sanitizeNoteHtml()` (メモ表示用 緩め、`class` / `input[type=checkbox]` 許可) — DOMPurify
- ファイル名: `normalize('NFC')` で macOS NFD 問題を回避
- prefix: `[A-Za-z0-9_-]` 以外を除去
- スラッシュ メニュー入力: URL 誤検出を回避 (`https://` 等で発動しない)

---

## I'. 既知の制約 / デファー項目 (2026-05-15 codex レビュー結果)

直近の codex レビューで指摘されたが、今回スコープ外として **明示的にデファー**した項目。実装時の優先度は P2 以下。

1. **キーボード単独操作** — サイドバー遷移 / 一覧行オープン / Inbox 行展開 / ソート / ステータス変更 等は `<div role="button" tabindex="0" onclick=...>` の構造で、Enter/Space/Arrow ハンドラが無い。マウスなしでは操作完結できない。修正には主要 clickable 要素を `<button>` / `<a>` に置き換えるか、各所に keydown を実装する必要があり影響範囲が広いため後回し。
2. **メモ内に Markdown 構文をリテラル入力** — エディタに `**bold**` や `` `code` `` を text として直接入力すると、保存→再読込で太字 / インラインコードに変換される。`escapeMd()` ヘルパは定義済みだが `inlineToMd` で text node に未適用。エスケープを片側だけ入れると `\*` がリテラルとして残り別の混乱を生むため、双方向の escape/unescape を整備するまで現状維持。内部メモ用途で実害は限定的。

---

## I. レビュー観点 (重点項目)

以下を中心に検証してほしい:

1. **データ整合性**: 同時編集 / 重複保存 / N+1 race / SP REST のエラー処理が雑な箇所
2. **メモ エディタ**: スラッシュ削除 + setBlockTag の caret 安全性、自動保存と DOM 操作の race、複数エディタ インスタンス同時マウント時の干渉
3. **ファイル添付**: 衝突回避ループの上限 (100 回) は妥当か、NFC 正規化漏れ箇所、Exists payload 判定の取りこぼし、SP エラー型の判別、メモ削除時の物理ファイル放置
4. **重複起票防止**: `findDuplicateTicketForMail()` の比較が `sentAt` を見ているが古い行は `receivedAt` フォールバック — フォールバック時に誤検知/取りこぼしリスク
5. **Markdown ラウンドトリップ**: blockquote / callout / table / file chip / image / inline code のエンティティ二重エスケープ、NoteRich のエンティティ デコード漏れ
6. **PA ヘルプ式**: コピペした式が SP の現行 connector で実際に動くか、レガシー形式の互換性
7. **TypeScript**: any/unknown キャストの取りこぼし、Promise 連鎖の未 await
8. **SP 固有**: ConversationId / 親フォルダ作成失敗 / リスト リセット後の列追加リトライ / ensureFields 多言語化判定の堅牢性
9. **アクセシビリティ**: キーボードのみで操作可能か (スラッシュ メニュー以外)
10. **i18n / 文字化け**: NoteRich → BMP 外文字、Windows ファイル名禁則文字 (`# % & * : < > ? / \ { | }`) の未エスケープ
