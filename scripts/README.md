# Spira relay — Pure PowerShell (AI + Outlook)

ブラウザの Spira からローカル PC 上で動く 2 種類の機能を提供する HTTP リレー:

1. **AI gateway 中継** — 社内 AI ゲートウェイ (Azure OpenAI 互換) へオンプレ
   プロキシ経由で呼び出しを転送 (`/openai/...` 等を upstream に forward)
2. **Outlook 返信下書き** — Spira UI からのリクエストで Outlook デスクトップに
   「特定の InternetMessageId への正規 Reply 下書き」を開く (`/spira/outlook/reply`)
3. **死活確認** — `GET /spira/health` で起動中かどうかを Spira UI が確認

**Python 等の外部ランタイム不要**で、Windows 標準の PowerShell + .NET
(HttpClient / HttpListener) + Outlook COM だけで動く。

## 必要な構成

```
Spira (bookmarklet)
        │  http://localhost:18080
        ▼
spira-ai-relay.ps1   (PowerShell on local PC)
   ├─ /spira/outlook/reply   → Outlook COM (.Reply / .Display)
   ├─ /spira/health          → 起動応答
   └─ それ以外               → https via proxy → 社内 AI ゲートウェイ
```

ブラウザは loopback (`127.0.0.1`) には到達できるので、リレーが両端の橋渡しを
する。社内プロキシ経由の認証も PS 側で完結。Outlook 返信は COM 経由でローカルの
Outlook クライアントに描画する (relay 内で完結、upstream には行かない)。

## ファイル

| ファイル | 役割 |
|----------|------|
| `spira-ai-relay.ps1` | リレー本体。HTTP listener + プロキシ + ストリーミング転送 |
| `spira-ai-relay.bat` | ダブルクリック起動用の薄い wrapper |
| `spira-ai-relay.env.example` | 設定ファイルのテンプレート (リポジトリにコミット) |
| `spira-ai-relay.env` | 各人の実設定 (`.gitignore` で除外、コミットされない) |

## 使い方

### 1. 設定ファイルを作成

テンプレートをコピーして編集:

```ps
Copy-Item spira-ai-relay.env.example spira-ai-relay.env
notepad spira-ai-relay.env
```

`.env` の中身 (`KEY=VALUE` 形式):

```ini
SPIRA_AI_TARGET=https://gateway.example.com/myapi
SPIRA_AI_PROXY=http://onprem-proxy.example.com:8080
SPIRA_AI_PORT=18080
# SPIRA_AI_SKIP_CERT_CHECK=1   ← 自己署名証明書のみ (検証用)
```

- `SPIRA_AI_TARGET` — 社内 AI ゲートウェイの URL (パス込み)。**未設定でも relay は起動可能**で、その場合 AI 中継は無効、Outlook 返信中継だけ有効になる
- `SPIRA_AI_PROXY` — オンプレ プロキシ URL (不要なら行ごと削除)
- `SPIRA_AI_PORT` — ローカル listen ポート (既定 18080)

`.env` は `.gitignore` で除外されているのでコミットされません。

> **設定の優先順位**: コマンドライン引数 > プロセス環境変数 > `.env` ファイル > デフォルト値

### 2. 起動

`spira-ai-relay.bat` をダブルクリック。コンソールに以下が表示されたら準備完了:

```
────────────────────────────────────────────────────────────────────────
  Spira AI relay (PowerShell)
────────────────────────────────────────────────────────────────────────
  listen  : http://127.0.0.1:18080
  target  : https://gateway.example.com/myapi
  proxy   : http://onprem-proxy.example.com:8080
────────────────────────────────────────────────────────────────────────
Spira の「AI 設定」モーダルでベース URL に下記いずれかを入力:
  A: http://localhost:18080
  B: http://localhost:18080/myapi    (実 URL のパスを保ったまま localhost に置換、視認性◎)
────────────────────────────────────────────────────────────────────────
Ctrl+C で終了
```

### 3. Spira 側の設定

設定メニュー → 「AI 設定」モーダルを開き:

| フィールド | 設定値 |
|------------|--------|
| プロバイダ | 社内 AI (Azure OpenAI 互換) |
| API キー | 社内ゲートウェイのサブスクリプション キー |
| ベース URL | `http://localhost:18080` (or `http://localhost:18080/myapi`) |
| デプロイ ID プレフィックス | 組織の規約に合わせて (例: `spira-`) |
| モデル | `gpt-4.1-mini` 等 |

「保存」 → チケット詳細の右ペインの AI チャットで動作確認。

## 引数 (高度な使い方)

PowerShell から直接呼ぶ場合は引数で指定可:

```ps
.\spira-ai-relay.ps1 `
  -Target 'https://gateway.example.com/myapi' `
  -Proxy  'http://onprem-proxy.example.com:8080' `
  -Port   18080
```

その他のオプション:

| 引数 | 説明 |
|------|------|
| `-NoProxy` | プロキシ無しで直接ゲートウェイへ (デバッグ用途) |
| `-SkipCertCheck` | ⚠ 自己署名証明書のゲートウェイ用。本番では使わない |

## Outlook 中継について

Spira の「📧 返信メール作成」ボタンは 2 モードで動作し、どちらも
**operator の Outlook デスクトップ クライアント** に下書きを表示する。
OWA ベースの操作は一切無い (relay 経由のみ)。

### モード判定 (Spira UI 側)

- 外部対応経緯に source=mail の受信履歴がある
   → **reply モード** (`POST /spira/outlook/reply`、検索キー: 送信時刻 + 送信者)
- 受信メール履歴ゼロ / Forms 起票 / 手動起票 / Teams のみ
   → **new モード** (`POST /spira/outlook/new`、テンプレ件名・本文・宛先)

### reply モード — 既存メールへの正規 Reply

```
[Spira UI] POST /spira/outlook/reply
        { sentAtIso: "2026-05-19T10:30:00Z",
          fromEmail: "alice@customer.example",
          bodyHtml: "<p>回答...</p>", cc: ["..."] }
        │
[relay] Outlook.Application を COM で取得
        │
        ├─ Inbox.Items.Restrict (高速)
        │   DASL: PR_SENT_REPRESENTING_SMTP_ADDRESS = '<fromEmail>'
        │       AND 送信時刻 = '<sentAt 秒精度>' (= 完全一致)
        └─ AdvancedSearch (全ストア再帰、ルールでサブフォルダに振り分け済も対象)
        │
        $orig.Reply() で正規返信下書きを生成
        $reply.HTMLBody = bodyHtml + $reply.HTMLBody (引用部の上に prepend)
        $reply.Display()   ← Outlook ウィンドウが開く
```

検索キーを「送信時刻 + 送信者」にしたのは:
- `InternetMessageId` は Spira 経由で取り込んだメール (PA フロー①) でしか
  保存されておらず、.msg ドラッグや手動入力では欠落しがち
- 送信時刻 (Comments.sentAt) + 送信者 (Comments.fromEmail) は **どの経路で
  取り込んだメールでも必ず揃っている** ため、検索キーとして信頼できる
- 送信者 + 分単位の時刻が同じメールは現実的には一意

### new モード — 新規メール下書き

```
[Spira UI] POST /spira/outlook/new
        { to: "alice@customer.example",
          subject: "[#00012] チケットタイトル",
          bodyHtml: "<p>テンプレ本文...</p>", cc: ["..."] }
        │
[relay] $mail = $outlook.CreateItem(0)   # olMailItem
        $mail.Subject = subject
        $mail.To      = to
        $mail.HTMLBody = bodyHtml
        $mail.Display()  ← 新規メール作成画面 (In-Reply-To 無し)
```

次回の申請者からの返信は **件名のチケット ID タグ** (`[#NNNNN]`) で
PA フロー① が自動的に既存チケットに紐付ける (auto-link)。

### 要件 / 制約

- **Windows + Outlook デスクトップ クライアント** が必須 (COM が必要)
- relay と Outlook は **同じユーザセッション** で動作 (= operator の PC)
- reply モードは operator の Outlook 内に元メールが存在することが前提
   (Inbox / 全フォルダ / PST 全部を再帰検索する)

### エラー時の挙動

relay 停止 / Outlook 未起動 / 元メール見つからない場合は Spira UI で
**エラートーストを出して停止**。OWA フォールバックは廃止。
operator は relay と Outlook を起動してから再試行する運用。

## タスクスケジューラで常駐させる

毎朝 PC ログオン時に自動起動させたい場合:

1. `taskschd.msc` を起動
2. 「タスクの作成」
3. **トリガー**: ログオン時
4. **操作**: プログラム = `cmd.exe`、引数 = `/c "%~dp0spira-ai-relay.bat"` (パス調整)
5. **設定**: 「タスクを停止するまで再起動を続ける」を ON

これで PC 起動と同時にリレーが立ち上がる。

## トラブルシューティング

### `ポート 18080 を listen できませんでした`
- 別プロセスが同じポートを使用中。`Get-NetTCPConnection -LocalPort 18080` で確認
- `-Port 28080` のように別ポートで起動。Spira 側の「ベース URL」も同期

### ブラウザのコンソールに `Failed to fetch / CORS error`
- リレーが起動していない、または別ポートで動いている
- リレーのコンソールにリクエスト ログ (`[hh:mm:ss] POST /...`) が出るか確認
- 出ないなら Spira の「ベース URL」がリレーを指していない

### `upstream_error` がリレー側で返る
- プロキシまたはゲートウェイへの接続に失敗
- リレーのコンソール末尾にエラー詳細が出る (proxy 接続失敗 / SSL / DNS 等)
- `-NoProxy` で直接接続を試してから、プロキシの URL を再確認

### `ExecutionPolicy` でブロックされる
- `.bat` 経由なら `-ExecutionPolicy Bypass` 付きで起動するので問題なし
- 直接 `.ps1` を叩いてエラーが出る場合のみ、`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` を実行

## セキュリティ

- リレーは `127.0.0.1` のみで listen (外部からは到達不能)
- CORS は `*` で許可しているが、loopback のみなので外部攻撃面なし
- API キーは Spira (localStorage) ↔ リレー間でのみ流れる、ディスクに残らない
- `-SkipCertCheck` は **絶対に本番運用で使わない**こと (中間者攻撃を防げなくなる)
