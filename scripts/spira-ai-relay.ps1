# ============================================================================
# Spira corp-AI relay  (Pure PowerShell, no Python)
# ============================================================================
#
# ブラウザ (Spira bookmarklet) から社内 AI ゲートウェイをオンプレ プロキシ
# 経由で呼び出すための、ローカルで動く小さな HTTP リレー。
#
# なぜ必要か
# ----------
# ブラウザの fetch() は環境変数 HTTP_PROXY / HTTPS_PROXY を読まないし、
# Fetch API の仕様でプロキシを per-request で指定する方法もない。よって
# bookmarklet から「社内 AI ゲートウェイには必ず社内プロキシ経由で行く」
# というルーティングを直接表現できない。
#
#   Spira (browser) --HTTP--> http://127.0.0.1:18080 --HTTPS via proxy-->  gateway
#
# ブラウザは loopback には到達できる (プロキシ判定はループバックを除外)。
# PS 側は HttpClient で proxy を指定できる。
#
# 使い方
# ------
#   # 1. 設定ファイルを準備:
#   PS> Copy-Item spira-ai-relay.env.example spira-ai-relay.env
#   PS> notepad spira-ai-relay.env       # 値を編集
#
#   # 2. PowerShell から実行:
#   PS> .\spira-ai-relay.ps1
#
#   # または引数で個別に上書き:
#   PS> .\spira-ai-relay.ps1 -Target 'https://...' -Proxy 'http://...:8080'
#
# 設定の優先順位:
#   1. コマンドライン引数 (-Target / -Proxy / -Port)
#   2. プロセス環境変数 (SPIRA_AI_TARGET 等)
#   3. spira-ai-relay.env ファイル (同じフォルダ)
#   4. デフォルト値 (port = 18080)
#
# Spira の「AI 設定」モーダルで:
#   プロバイダ              : 社内 AI (Azure OpenAI 互換)
#   ベース URL              : http://localhost:18080
#                            (または http://localhost:18080/<gateway path>)
#   デプロイ ID プレフィックス : (組織の規約に合わせて)
#   API キー                : サブスクリプションキー
#
# 必要環境
# --------
#   Windows PowerShell 5.1 以上 / PowerShell 7+ (どちらも .NET HttpClient
#   と HttpListener が標準で使える)。Python 不要。
#
# 注: HttpListener が 127.0.0.1 で listen するので管理者権限は不要。
# ============================================================================

[CmdletBinding()]
param(
    [string]$Target,
    [string]$Proxy,
    [int]$Port,
    [switch]$NoProxy,
    # 社内ゲートウェイが自己署名証明書の場合 (要セキュリティ承認)
    [switch]$SkipCertCheck,
    # 環境設定ファイルのパス (既定: スクリプトと同じフォルダの spira-ai-relay.env)
    [string]$EnvFile
)

$ErrorActionPreference = 'Stop'

# ─── Load .env file ─────────────────────────────────────────────────────────
#
# 設定の中央集権化: 同じフォルダの `spira-ai-relay.env` を読み、まだ
# 設定されていない `$env:SPIRA_AI_*` だけセットする。プロセス環境変数や
# 引数が既に与えられていれば、それを優先する (上書きしない)。
#
# `.env` の書式は KEY=VALUE。`#` で始まる行と空行は無視。値の前後の
# クォート (`"..."` / `'...'`) は剥がす。

function Import-EnvFile {
    param([string]$Path)
    if (-not (Test-Path -LiteralPath $Path)) { return $false }
    try {
        $lines = Get-Content -LiteralPath $Path -Encoding UTF8 -ErrorAction Stop
    } catch {
        Write-Warning ".env ファイルを読めませんでした: $Path ($($_.Exception.Message))"
        return $false
    }
    foreach ($raw in $lines) {
        $line = $raw.Trim()
        if (-not $line) { continue }
        if ($line.StartsWith('#')) { continue }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }                           # 不正な行は skip
        $key = $line.Substring(0, $eq).Trim()
        $val = $line.Substring($eq + 1).Trim()
        # 末尾のインライン コメント (` # ...`) を削除 — クォート外のみ
        if ($val -notmatch '^["'']') {
            $hashIdx = $val.IndexOf(' #')
            if ($hashIdx -ge 0) { $val = $val.Substring(0, $hashIdx).TrimEnd() }
        }
        # 前後のクォートを剥がす
        if (($val.StartsWith('"') -and $val.EndsWith('"')) -or
            ($val.StartsWith("'") -and $val.EndsWith("'"))) {
            $val = $val.Substring(1, $val.Length - 2)
        }
        # プロセス環境変数に未設定のときだけ反映 (引数 / 既存 env を優先)
        if (-not [Environment]::GetEnvironmentVariable($key)) {
            [Environment]::SetEnvironmentVariable($key, $val)
        }
    }
    return $true
}

# .env のパス解決: 明示指定 → スクリプト同フォルダの spira-ai-relay.env
if (-not $EnvFile) {
    $EnvFile = Join-Path $PSScriptRoot 'spira-ai-relay.env'
}
$loaded = Import-EnvFile -Path $EnvFile
if ($loaded) {
    Write-Host "[config] loaded: $EnvFile" -ForegroundColor DarkGray
}

# 引数 → 環境変数 → デフォルト の順で確定
if (-not $Target) { $Target = $env:SPIRA_AI_TARGET }
if (-not $Proxy)  { $Proxy  = $env:SPIRA_AI_PROXY }
if (-not $Port)   {
    $Port = if ($env:SPIRA_AI_PORT) { [int]$env:SPIRA_AI_PORT } else { 18080 }
}
if (-not $SkipCertCheck -and $env:SPIRA_AI_SKIP_CERT_CHECK -eq '1') {
    $SkipCertCheck = [switch]$true
}

# ─── Pre-flight checks ──────────────────────────────────────────────────────

if (-not $Target) {
    # AI gateway を使わない運用 (Outlook 返信中継だけ使う等) を許可。
    # /spira/* のローカル機能だけで起動する。
    Write-Host '注意: AI gateway URL (-Target) が未指定です。' -ForegroundColor Yellow
    Write-Host '  AI 中継 (Azure OpenAI 互換 forwarding) は無効化されます。'
    Write-Host '  /spira/outlook/reply / /spira/health のローカル機能は通常通り動作します。'
    Write-Host ''
}

if (-not $NoProxy -and -not $Proxy) {
    Write-Host '警告: プロキシが未指定です。直接接続を試みます (社内環境では失敗する可能性が高いです)。' -ForegroundColor Yellow
}

# ─── HttpClient setup ───────────────────────────────────────────────────────

Add-Type -AssemblyName System.Net.Http | Out-Null

$handler = New-Object System.Net.Http.HttpClientHandler
$handler.AllowAutoRedirect = $true
$handler.AutomaticDecompression = [System.Net.DecompressionMethods]::None  # SSE のため未解凍で流す

if (-not $NoProxy -and $Proxy) {
    $handler.Proxy = New-Object System.Net.WebProxy($Proxy, $true)  # bypassOnLocal=true
    $handler.UseProxy = $true
}
else {
    $handler.UseProxy = $false
}

if ($SkipCertCheck) {
    # ⚠ 本番運用では不可。検証用のみ。
    $handler.ServerCertificateCustomValidationCallback =
        [System.Net.Http.HttpClientHandler]::DangerousAcceptAnyServerCertificateValidator
}

$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromMinutes(10)  # AI 応答は数分かかる場合あり

# ─── Target URL parsing ─────────────────────────────────────────────────────
# AI gateway を使わない運用 (Outlook 中継のみ) では $Target が空。
# その場合は forwarding 不可なので targetPath を空のままにし、
# Invoke-RelayRequest 側で 502 を返す。

$targetPath = ''
if ($Target) {
    $Target = $Target.TrimEnd('/')
    $targetUri = [Uri]$Target
    $targetPath = $targetUri.AbsolutePath
    if ($targetPath -eq '/') { $targetPath = '' }
}

# ─── HttpListener setup ─────────────────────────────────────────────────────

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
try {
    $listener.Start()
}
catch {
    Write-Host ''
    Write-Host "エラー: ポート $Port を listen できませんでした。" -ForegroundColor Red
    Write-Host "  - 別プロセスが同じポートを使っている可能性 (Get-NetTCPConnection -LocalPort $Port)"
    Write-Host '  - または別ポートを -Port 引数で指定してください'
    Write-Host "詳細: $($_.Exception.Message)"
    exit 1
}

$baseUrlShort  = "http://localhost:$Port"
$baseUrlMirror = if ($targetPath) { "$baseUrlShort$targetPath" } else { $baseUrlShort }

Write-Host ('─' * 72)
Write-Host '  Spira relay (PowerShell) — AI + Outlook'
Write-Host ('─' * 72)
Write-Host "  listen  : http://127.0.0.1:$Port"
Write-Host ("  target  : " + $(if ($Target) { $Target } else { '(AI 中継 OFF)' }))
Write-Host "  proxy   : $(if ($NoProxy -or -not $Proxy) { '(直接接続)' } else { $Proxy })"
if ($SkipCertCheck) { Write-Host '  ⚠ SSL 検証スキップ中 (-SkipCertCheck)' -ForegroundColor Yellow }
Write-Host ('─' * 72)
Write-Host 'ローカル機能エンドポイント (Spira UI が直接叩く):'
Write-Host "  GET  $baseUrlShort/spira/health"
Write-Host "  POST $baseUrlShort/spira/outlook/reply  (既存メールに対する正規 Reply 下書き、検索キー: 送信時刻 + 送信者)"
Write-Host "  POST $baseUrlShort/spira/outlook/new    (新規メール下書き、To / Subject / Body 直接指定)"
if ($Target) {
    Write-Host ''
    Write-Host 'Spira の「AI 設定」モーダルでベース URL に下記いずれかを入力:'
    Write-Host "  A: $baseUrlShort"
    if ($baseUrlShort -ne $baseUrlMirror) {
        Write-Host "  B: $baseUrlMirror    (実 URL のパスを保ったまま localhost に置換、視認性◎)"
    }
}
Write-Host ('─' * 72)
Write-Host 'Ctrl+C で終了' -ForegroundColor DarkGray
Write-Host ''

# ─── CORS helper ────────────────────────────────────────────────────────────

function Add-CorsHeaders {
    param([System.Net.HttpListenerResponse]$Response)
    # bookmarklet は SharePoint オリジンから動くので明示許可。listen は
    # loopback だけなので `*` でも外部から到達できず安全。
    $Response.Headers.Add('Access-Control-Allow-Origin', '*')
    $Response.Headers.Add('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    $Response.Headers.Add(
        'Access-Control-Allow-Headers',
        'Content-Type, api-key, Accept, Authorization, X-Requested-With, anthropic-version, anthropic-dangerous-direct-browser-access, x-api-key'
    )
    $Response.Headers.Add('Access-Control-Max-Age', '86400')
}

# ─── Error helper ───────────────────────────────────────────────────────────

function Send-Error {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [int]$Status,
        [string]$Code,
        [string]$Detail
    )
    $payload = (@{ error = @{ code = $Code; detail = $Detail } } | ConvertTo-Json -Compress -Depth 4)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
    try {
        $Response.StatusCode = $Status
        Add-CorsHeaders -Response $Response
        $Response.ContentType = 'application/json; charset=utf-8'
        $Response.ContentLength64 = $bytes.Length
        $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
    catch { }
    finally { try { $Response.OutputStream.Close() } catch { } }
}

# ─── Local handlers: /spira/* (no upstream forwarding) ─────────────────────
#
# AI gateway への透過 forwarding とは別に、Spira UI が直接叩く
# ローカル機能 (= Outlook クライアント操作 / 死活確認) もこの relay で
# 受ける。/spira/* で始まるパスは forwarding せず、PowerShell 内で処理。
#   - GET  /spira/health           : 死活確認 (Spira UI のフォールバック判定)
#   - POST /spira/outlook/reply    : 既存メールに対する正規 Reply 下書きを開く
#   - POST /spira/outlook/new      : 新規メール下書きを開く
#
# ★★★ 重要な設計方針 ★★★
# Outlook 系ハンドラ (reply / new) は MailItem.Display() で
# 「下書き作成画面を表示する」 までしか行わない。
# .Send() は絶対に呼ばないこと。最終的な「送信」操作は operator 本人が
# Outlook クライアントで内容を確認した上で行う設計。
# (誤送信防止 / Outlook 標準の確認フロー / 個人 Sent Items への記録の
#  ためにも、この方針は変更しない。)

function Send-Json {
    param(
        [System.Net.HttpListenerResponse]$Response,
        [int]$Status,
        [object]$Body
    )
    $json  = ($Body | ConvertTo-Json -Compress -Depth 6)
    $bytes = [System.Text.Encoding]::UTF8.GetBytes($json)
    try {
        $Response.StatusCode    = $Status
        Add-CorsHeaders -Response $Response
        $Response.ContentType   = 'application/json; charset=utf-8'
        $Response.ContentLength64 = $bytes.Length
        $Response.OutputStream.Write($bytes, 0, $bytes.Length)
    } catch { }
    finally { try { $Response.OutputStream.Close() } catch { } }
}

# Outlook COM 取得ヘルパ (起動中ならアタッチ、止まっていれば起動)。
# 戻り値: COM オブジェクト or $null
function Get-OutlookOrNull {
    try {
        try { return [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') }
        catch { return (New-Object -ComObject Outlook.Application) }
    } catch { return $null }
}

# operator の Outlook ストア全体から返信対象メールを検索する。
#
# 検索キーの優先順位 (上から順に試行、最初にヒットしたものを採用):
#   1) InternetMessageId (RFC 5322 Message-ID ヘッダ)
#        - メール 1 通ごとに世界で一意。どのメールボックス / どのフォルダに
#          コピーされても同じ値を持つため、operator が個人ルールでサブフォルダ
#          に振り分けていても確実にヒットする最強キー。
#        - Spira は PA フロー① が triggerOutputs()['body/InternetMessageId']
#          を Comments.internetMessageId に保存しているので ML 受信メールでは
#          必ず使える。
#   2) 送信時刻 (秒精度) + 送信者 SMTP
#        - .msg ドラッグ / 手動起票で message-id が欠落しているケースの
#          フォールバック。送信者 + 送信秒が同じメールは現実的に一意。
#
# 各キーごとに:
#   a) Inbox 直探索 (Items.Restrict、高速)
#   b) ヒット無しなら AdvancedSearch で全 Store / 全フォルダ再帰
# 戻り値: 見つかった MailItem (COM) または $null
function Find-OutlookMessage {
    param(
        $Outlook,
        [string]$InternetMessageId,
        [string]$FromEmail,
        [string]$SentAtIso
    )
    $ns = $Outlook.GetNamespace('MAPI')

    # --- 検索 DASL のリストを優先順位順に組み立てる ---------------------
    $daslList = @()

    # 1) InternetMessageId (message-id ヘッダ)。
    #    urn:schemas:mailheader:message-id と PR_INTERNET_MESSAGE_ID
    #    (0x1035001F) の両タグを試す (ストアにより露出するタグが異なる)。
    #    値はブラケット <...> 付き / 無しの両表記を試す (取り込み経路で揺れる)。
    if ($InternetMessageId) {
        $mid = ([string]$InternetMessageId).Trim()
        $midNoBracket = $mid.Trim('<', '>')
        $variants = @($mid)
        if ($midNoBracket -ne $mid) { $variants += $midNoBracket }
        $variants += "<$midNoBracket>"
        $variants = $variants | Select-Object -Unique
        $tagMidHdr  = 'urn:schemas:mailheader:message-id'
        $tagMidProp = 'http://schemas.microsoft.com/mapi/proptag/0x1035001F'
        foreach ($v in $variants) {
            $safeMid = ($v -replace "'", "''")
            $daslList += "@SQL=""$tagMidHdr"" = '$safeMid'"
            $daslList += "@SQL=""$tagMidProp"" = '$safeMid'"
        }
    }

    # 2) 送信時刻 (秒精度・完全一致) + 送信者 SMTP のフォールバック。
    #   PR_SENT_REPRESENTING_SMTP_ADDRESS (0x5D01001F) — 送信者の SMTP アドレス
    #   urn:schemas:httpmail:date         — 送信時刻 (PR_CLIENT_SUBMIT_TIME)
    #   urn:schemas:httpmail:datereceived — 受信時刻 (sentAt が取れていない運用の保険)
    if ($FromEmail -and $SentAtIso) {
        $sent = $null
        try { $sent = [DateTime]::Parse($SentAtIso).ToUniversalTime() } catch { $sent = $null }
        if ($sent) {
            $exact       = $sent.ToString('yyyy-MM-dd HH:mm:ss')
            $tagSent     = 'urn:schemas:httpmail:date'
            $tagReceived = 'urn:schemas:httpmail:datereceived'
            $tagSender   = 'http://schemas.microsoft.com/mapi/proptag/0x5D01001F'
            $safeFrom    = ($FromEmail -replace "'", "''").Trim()
            $daslList += "@SQL=""$tagSender"" = '$safeFrom' AND ""$tagSent"" = '$exact'"
            $daslList += "@SQL=""$tagSender"" = '$safeFrom' AND ""$tagReceived"" = '$exact'"
        }
    }

    if ($daslList.Count -eq 0) { return $null }

    # --- a) Inbox を Restrict で絞る (高速) ----------------------------
    try {
        $inbox = $ns.GetDefaultFolder(6)  # olFolderInbox
        foreach ($dasl in $daslList) {
            try {
                $sub = $inbox.Items.Restrict($dasl)
                if ($sub.Count -ge 1) { return $sub.Item(1) }
            } catch { }
        }
    } catch { }

    # --- b) 全 Store / 全フォルダの AdvancedSearch ---------------------
    try {
        foreach ($store in $ns.Stores) {
            $root = $null
            try { $root = $store.GetRootFolder() } catch { continue }
            if (-not $root) { continue }
            $scope = "'" + $root.FolderPath + "'"
            foreach ($dasl in $daslList) {
                $search = $null
                try {
                    $search = $Outlook.AdvancedSearch($scope, $dasl, $true, 'spira-find')
                } catch { continue }
                $waitMs = 0
                while ($waitMs -lt 5000) {
                    Start-Sleep -Milliseconds 100
                    $waitMs += 100
                    try {
                        if ($search.Results -and $search.Results.Count -gt 0) {
                            return $search.Results.Item(1)
                        }
                    } catch { }
                }
            }
        }
    } catch { }
    return $null
}

# POST /spira/outlook/reply
# 入力 JSON: {
#   internetMessageId?: string,  // 最優先の検索キー (RFC 5322 Message-ID)
#   sentAtIso?: string,          // フォールバック検索キー (送信時刻)
#   fromEmail?: string,          // フォールバック検索キー (送信者 SMTP)
#   to?: string,                 // 反映する To (未指定なら自動 To を保持)
#   cc?: string[], replyTo?: string[], bodyHtml: string
# }
# internetMessageId か (sentAtIso + fromEmail) のいずれかは必須。
function Invoke-OutlookReplyHandler {
    param(
        [System.Net.HttpListenerRequest]$Request,
        [System.Net.HttpListenerResponse]$Response
    )

    if ($Request.HttpMethod.ToUpper() -ne 'POST') {
        Send-Json -Response $Response -Status 405 `
            -Body @{ ok = $false; error = @{ code = 'method_not_allowed'; detail = 'POST only' } }
        return
    }

    $payload = $null
    try {
        # JSON 本文は常に UTF-8 として読む。
        # HttpListenerRequest.ContentEncoding は Content-Type に charset が
        # 無いとき OS の既定 (日本語 Windows なら CP932) を返してしまうため、
        # それを使うと UTF-8 の日本語が文字化けして JSON パースが落ちる。
        # Spira (ブラウザ fetch) は仕様通り UTF-8 で送信するので、明示固定で OK。
        $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
        $raw    = $reader.ReadToEnd()
        $reader.Dispose() | Out-Null
        if ($raw) { $payload = $raw | ConvertFrom-Json }
    } catch {
        Send-Json -Response $Response -Status 400 `
            -Body @{ ok = $false; error = @{ code = 'bad_json'; detail = $_.Exception.Message } }
        return
    }
    # 検索キーは InternetMessageId が最優先、無ければ sentAt + fromEmail。
    # どちらか一方でも揃っていればよい。
    $hasMid  = [bool]$payload.internetMessageId
    $hasTime = ($payload.sentAtIso -and $payload.fromEmail)
    if (-not $hasMid -and -not $hasTime) {
        Send-Json -Response $Response -Status 400 `
            -Body @{ ok = $false; error = @{ code = 'missing_field'; detail = 'internetMessageId, or (sentAtIso + fromEmail), is required' } }
        return
    }

    $outlook = Get-OutlookOrNull
    if (-not $outlook) {
        Send-Json -Response $Response -Status 500 `
            -Body @{ ok = $false; error = @{ code = 'outlook_not_available'; detail = 'Failed to acquire Outlook.Application COM' } }
        return
    }

    $orig = $null
    try {
        $orig = Find-OutlookMessage -Outlook $outlook `
                  -InternetMessageId $payload.internetMessageId `
                  -FromEmail $payload.fromEmail -SentAtIso $payload.sentAtIso
    } catch { }
    if (-not $orig) {
        Send-Json -Response $Response -Status 404 `
            -Body @{ ok = $false; error = @{ code = 'message_not_found'; detail = "Mail not found by messageId=$($payload.internetMessageId) sentAtIso=$($payload.sentAtIso) fromEmail=$($payload.fromEmail)" } }
        return
    }

    try {
        $reply = $orig.Reply()
        $bodyHtml = "$($payload.bodyHtml)"
        if ($bodyHtml) {
            # Spira から渡る bodyHtml はスタイル指定の無い <p>...</p> なので、
            # そのまま prepend すると Outlook が「Times New Roman など HTML 既定」
            # で描画してダサい。元メール引用部 (Outlook 自動生成) と同じ和文
            # フォント感に揃えるため、<div style=...> でラップしてから付ける。
            #   - 游ゴシック UI / Meiryo UI を 10.5pt (Outlook 日本語の典型)
            #   - 色は黒固定 (テーマで白文字になるのを防ぐ)
            $styled = '<div style="font-family:''Yu Gothic UI'',''Meiryo UI'',''Yu Gothic'',sans-serif; font-size:10.5pt; color:#000;">' + $bodyHtml + '</div>'
            $reply.HTMLBody = $styled + $reply.HTMLBody
        }
        # 宛先 (To/Cc) を Spira モーダルの編集値で確実に再構築する。
        # payload.to が来ている場合は .Reply() が自動で入れた To (元送信者)
        # を一旦クリアして、operator が UI で確定した To / Cc をそのまま
        # 下書きに反映する (= 「ちゃんと反映された形で」)。
        # payload.to が無い場合 (後方互換) は自動 To を保持して Cc だけ追記。
        $toList = @()
        if ($payload.to) {
            # To は ';' / ',' / 空白区切りの複数アドレスを許容
            $toList = @(([string]$payload.to) -split '[;,\s]+' | Where-Object { $_ })
        }
        if ($toList.Count -gt 0) {
            # 既存 (自動生成された) 受信者を全削除してから再構築
            for ($i = $reply.Recipients.Count; $i -ge 1; $i--) {
                try { $reply.Recipients.Remove($i) } catch { }
            }
            foreach ($addr in $toList) {
                ($reply.Recipients.Add([string]$addr)).Type = 1  # olTo
            }
        }
        if ($payload.cc) {
            foreach ($addr in $payload.cc) {
                if ($addr) {
                    ($reply.Recipients.Add([string]$addr)).Type = 2  # olCC
                }
            }
        }
        # 受信者を 1 つでも触ったら解決をかける
        if ($toList.Count -gt 0 -or $payload.cc) {
            $null = $reply.Recipients.ResolveAll()
        }
        # Reply-To 設定 (Spira 設定の「メール返信 — 共通 ML」)。
        # MailItem.ReplyRecipientNames はセミコロン区切りで複数指定可。
        # 受信者がこの下書きから送るメールに「返信」した時の宛先を制御できる。
        if ($payload.replyTo) {
            $rtList = @($payload.replyTo | Where-Object { $_ }) -join '; '
            if ($rtList) { $reply.ReplyRecipientNames = $rtList }
        }
        # ★ 設計上ここで .Send() は絶対に呼ばない。下書きを表示するだけ。
        # ★ 最終的な「送信」ボタン操作は operator 本人が Outlook クライアントで
        # ★ 確認した上で行う。誤送信防止のため、この方針は変更しないこと。
        $reply.Display()
        Send-Json -Response $Response -Status 200 -Body @{ ok = $true }
    } catch {
        Send-Json -Response $Response -Status 500 `
            -Body @{ ok = $false; error = @{ code = 'outlook_reply_failed'; detail = $_.Exception.Message } }
    }
}

# POST /spira/outlook/new
# 入力 JSON: { to: string, subject: string, bodyHtml: string, cc?: string[] }
# 新規メール下書きを Outlook で開く (In-Reply-To 無し)。
function Invoke-OutlookNewHandler {
    param(
        [System.Net.HttpListenerRequest]$Request,
        [System.Net.HttpListenerResponse]$Response
    )

    if ($Request.HttpMethod.ToUpper() -ne 'POST') {
        Send-Json -Response $Response -Status 405 `
            -Body @{ ok = $false; error = @{ code = 'method_not_allowed'; detail = 'POST only' } }
        return
    }

    $payload = $null
    try {
        # JSON 本文は常に UTF-8 として読む。
        # HttpListenerRequest.ContentEncoding は Content-Type に charset が
        # 無いとき OS の既定 (日本語 Windows なら CP932) を返してしまうため、
        # それを使うと UTF-8 の日本語が文字化けして JSON パースが落ちる。
        # Spira (ブラウザ fetch) は仕様通り UTF-8 で送信するので、明示固定で OK。
        $reader = New-Object System.IO.StreamReader($Request.InputStream, [System.Text.Encoding]::UTF8)
        $raw    = $reader.ReadToEnd()
        $reader.Dispose() | Out-Null
        if ($raw) { $payload = $raw | ConvertFrom-Json }
    } catch {
        Send-Json -Response $Response -Status 400 `
            -Body @{ ok = $false; error = @{ code = 'bad_json'; detail = $_.Exception.Message } }
        return
    }
    if (-not $payload -or -not $payload.to -or -not $payload.subject) {
        Send-Json -Response $Response -Status 400 `
            -Body @{ ok = $false; error = @{ code = 'missing_field'; detail = 'to and subject are required' } }
        return
    }

    $outlook = Get-OutlookOrNull
    if (-not $outlook) {
        Send-Json -Response $Response -Status 500 `
            -Body @{ ok = $false; error = @{ code = 'outlook_not_available'; detail = 'Failed to acquire Outlook.Application COM' } }
        return
    }

    try {
        # 0 = olMailItem
        $mail = $outlook.CreateItem(0)
        $mail.Subject = [string]$payload.subject
        $mail.To      = [string]$payload.to
        if ($payload.cc) {
            $ccLine = ($payload.cc | Where-Object { $_ }) -join '; '
            if ($ccLine) { $mail.CC = $ccLine }
        }
        # Reply-To (Spira 設定「メール返信 — 共通 ML」由来)。
        if ($payload.replyTo) {
            $rtList = @($payload.replyTo | Where-Object { $_ }) -join '; '
            if ($rtList) { $mail.ReplyRecipientNames = $rtList }
        }
        # 新規メールも reply と同じく、和文フォントを明示しないと Outlook が
        # HTML 既定の Times New Roman で描画してしまうため、<div style=...> で
        # ラップしてセット。詳細は /spira/outlook/reply のコメント参照。
        $bodyHtml = [string]$payload.bodyHtml
        $styled = '<div style="font-family:''Yu Gothic UI'',''Meiryo UI'',''Yu Gothic'',sans-serif; font-size:10.5pt; color:#000;">' + $bodyHtml + '</div>'
        $mail.HTMLBody = $styled
        # ★ 設計上ここで .Send() は絶対に呼ばない。下書きを表示するだけ。
        # ★ 最終的な「送信」ボタン操作は operator 本人が Outlook クライアントで
        # ★ 確認した上で行う。誤送信防止のため、この方針は変更しないこと。
        $mail.Display()
        Send-Json -Response $Response -Status 200 -Body @{ ok = $true }
    } catch {
        Send-Json -Response $Response -Status 500 `
            -Body @{ ok = $false; error = @{ code = 'outlook_new_failed'; detail = $_.Exception.Message } }
    }
}

# ─── Request handler ────────────────────────────────────────────────────────

function Invoke-RelayRequest {
    param([System.Net.HttpListenerContext]$Context)

    $request  = $Context.Request
    $response = $Context.Response
    $method   = $request.HttpMethod.ToUpper()
    $ts       = (Get-Date).ToString('HH:mm:ss')
    Write-Host ("[{0}] {1} {2}" -f $ts, $method, $request.Url.PathAndQuery)

    # ── CORS preflight ──
    if ($method -eq 'OPTIONS') {
        $response.StatusCode = 204
        Add-CorsHeaders -Response $response
        $response.OutputStream.Close()
        return
    }

    # ── ローカル機能エンドポイント (/spira/*) は upstream に流さない ──
    $path = $request.Url.AbsolutePath
    if ($path -eq '/spira/health') {
        Send-Json -Response $response -Status 200 -Body @{ ok = $true; relay = 'spira-ai-relay'; version = 1 }
        return
    }
    if ($path -eq '/spira/outlook/reply') {
        Invoke-OutlookReplyHandler -Request $request -Response $response
        return
    }
    if ($path -eq '/spira/outlook/new') {
        Invoke-OutlookNewHandler -Request $request -Response $response
        return
    }

    # ── AI gateway 未設定なら 502 ──
    # /spira/* (ローカル機能) は前段で処理済み。ここに来るのは AI 系の
    # リクエストなので、forward 先が無ければ素直にエラーを返す。
    if (-not $Target) {
        Send-Error -Response $response -Status 502 -Code 'no_upstream' `
            -Detail 'AI gateway (-Target) が未設定です。AI チャット機能を使うには relay 起動時に -Target を指定してください。'
        return
    }

    # ── Compose upstream URL ──
    # bookmarklet 側で baseUrl に `/myapi` を含めても含めなくても OK に
    # するため、incoming path 先頭が targetPath と一致したら剥がす。
    $incoming = $request.Url.PathAndQuery
    $rel = $incoming
    if ($targetPath -and $rel.StartsWith($targetPath)) {
        $rel = $rel.Substring($targetPath.Length)
        if (-not $rel) { $rel = '/' }
    }
    $upstreamUrl = $Target + $rel

    # ── Build HttpRequestMessage ──
    $httpMethod = New-Object System.Net.Http.HttpMethod($method)
    $msg = New-Object System.Net.Http.HttpRequestMessage($httpMethod, $upstreamUrl)

    # body forwarding (POST/PUT のみ)
    if ($request.HasEntityBody) {
        $ms = New-Object System.IO.MemoryStream
        $request.InputStream.CopyTo($ms)
        $bodyBytes = $ms.ToArray()
        $ms.Dispose()
        $content = New-Object System.Net.Http.ByteArrayContent($bodyBytes, 0, $bodyBytes.Length)
        if ($request.ContentType) {
            try {
                $content.Headers.ContentType =
                    [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse($request.ContentType)
            }
            catch { }
        }
        $msg.Content = $content
    }

    # header forwarding — 重要な認証/コンテンツ系のみ転送 (Host/Connection 等は除外)。
    # anthropic-* 系は Claude API 用、api-key は Azure OpenAI 用。
    $forwardKeys = @(
        'api-key', 'x-api-key',
        'accept', 'authorization',
        'anthropic-version', 'anthropic-dangerous-direct-browser-access'
    )
    foreach ($name in $request.Headers.AllKeys) {
        if ($forwardKeys -contains $name.ToLower()) {
            $val = $request.Headers[$name]
            $msg.Headers.TryAddWithoutValidation($name, $val) | Out-Null
        }
    }

    # ── Send upstream (stream-aware) ──
    try {
        # ResponseHeadersRead = ヘッダ受信時点で返って来る (本体は stream)。
        # SSE (text/event-stream) の chunk をリアルタイムに流すために必須。
        $task = $client.SendAsync(
            $msg,
            [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead
        )
        $upstream = $task.GetAwaiter().GetResult()

        $response.StatusCode = [int]$upstream.StatusCode
        Add-CorsHeaders -Response $response
        # Content-Type 反映 (text/event-stream を含む)
        $ct = $null
        if ($upstream.Content -and $upstream.Content.Headers.ContentType) {
            $ct = $upstream.Content.Headers.ContentType.ToString()
        }
        if ($ct) { $response.ContentType = $ct }
        # Cache-Control 反映 (SSE で no-cache が来ることがある)
        if ($upstream.Headers.CacheControl) {
            $response.Headers.Add('Cache-Control', $upstream.Headers.CacheControl.ToString())
        }
        # 既知の長さがあれば設定。SSE は無いことが多いので chunked にする。
        $sse = ($ct -and ($ct -like 'text/event-stream*'))
        if ($sse) {
            $response.SendChunked = $true
        }
        elseif ($upstream.Content.Headers.ContentLength) {
            $response.ContentLength64 = $upstream.Content.Headers.ContentLength
        }
        else {
            $response.SendChunked = $true
        }

        # ── Stream body chunk-by-chunk ──
        $upstreamStream = $upstream.Content.ReadAsStreamAsync().GetAwaiter().GetResult()
        $buffer = New-Object byte[] 1024
        while ($true) {
            $n = $upstreamStream.Read($buffer, 0, $buffer.Length)
            if ($n -le 0) { break }
            try {
                $response.OutputStream.Write($buffer, 0, $n)
                $response.OutputStream.Flush()
            }
            catch {
                # ブラウザがキャンセル → サイレントに終了
                break
            }
        }
        $upstreamStream.Dispose()
        $upstream.Dispose()
    }
    catch [System.Net.Http.HttpRequestException] {
        # プロキシ接続失敗 / SSL / DNS 失敗系
        $detail = $_.Exception.Message
        $inner = $_.Exception.InnerException
        if ($inner) { $detail += " — $($inner.Message)" }
        Send-Error -Response $response -Status 502 -Code 'upstream_error' -Detail $detail
    }
    catch {
        Send-Error -Response $response -Status 500 -Code 'relay_failed' -Detail $_.Exception.Message
    }
    finally {
        try { $response.OutputStream.Close() } catch { }
        try { $msg.Dispose() } catch { }
    }
}

# ─── Main loop ──────────────────────────────────────────────────────────────
#
# Ctrl+C で listener を止めて整理終了する。$listener.GetContext() は同期
# ブロッキングなので、リクエストが連続して来ない限り 1 並列で十分。
# 並列処理が必要なら BeginGetContext + AsyncCallback への書き換えも可能。

[Console]::TreatControlCAsInput = $false

try {
    while ($listener.IsListening) {
        $ctx = $null
        try {
            $ctx = $listener.GetContext()
        }
        catch [System.Net.HttpListenerException] {
            # listener が止められた → ループ終了
            break
        }
        if ($ctx) {
            try { Invoke-RelayRequest -Context $ctx }
            catch { Write-Warning "request handler error: $($_.Exception.Message)" }
        }
    }
}
finally {
    Write-Host ''
    Write-Host '[shutdown] stopping listener...' -ForegroundColor DarkGray
    try { $listener.Stop() } catch { }
    try { $listener.Close() } catch { }
    try { $client.Dispose() } catch { }
}
