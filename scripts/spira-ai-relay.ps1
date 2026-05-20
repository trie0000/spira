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
Write-Host "  POST $baseUrlShort/spira/outlook/reply"
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
#   - POST /spira/outlook/reply    : 指定 InternetMessageId に対する正規 Reply
#                                    下書きを Outlook デスクトップで開く

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

# 指定 InternetMessageId に一致するメールを Outlook ストア全体から探す。
# 1) まず GetDefaultFolder(Inbox) を Items.Find で軽く探索 (高速、典型ケース)
# 2) ヒットしなければ AdvancedSearch で Store ごとに SearchSubFolders=true。
#    operator の個人ルールでサブフォルダに振り分けられたメールも見つかる。
# 戻り値: 見つかった MailItem (COM) または $null
function Find-OutlookMessageByInternetMessageId {
    param(
        $Outlook,
        [string]$InternetMessageId
    )
    $ns   = $Outlook.GetNamespace('MAPI')
    $tag  = 'http://schemas.microsoft.com/mapi/proptag/0x1035001E'
    $dasl = '@SQL="' + $tag + '" = ''' + ($InternetMessageId -replace "'", "''") + ''''

    # 1) Inbox 直探索 (Items.Find は高速)
    try {
        $inbox = $ns.GetDefaultFolder(6)  # olFolderInbox
        $hit   = $inbox.Items.Find($dasl)
        if ($hit) { return $hit }
    } catch { }

    # 2) 全 Store / 全フォルダの AdvancedSearch (Inbox 外への振り分け対応)
    try {
        foreach ($store in $ns.Stores) {
            $root = $null
            try { $root = $store.GetRootFolder() } catch { continue }
            if (-not $root) { continue }
            $scope = "'" + $root.FolderPath + "'"
            $search = $null
            try {
                $search = $Outlook.AdvancedSearch($scope, $dasl, $true, 'spira-find')
            } catch { continue }
            # AdvancedSearch は非同期。完了イベントを Bind せず簡易ポーリング。
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
    } catch { }
    return $null
}

# /spira/outlook/reply 本体。
# 入力 JSON: { inReplyTo: string, bodyHtml: string, cc?: string[] }
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

    # JSON 入力読込
    $payload = $null
    try {
        $reader = New-Object System.IO.StreamReader($Request.InputStream, $Request.ContentEncoding)
        $raw    = $reader.ReadToEnd()
        $reader.Dispose() | Out-Null
        if ($raw) { $payload = $raw | ConvertFrom-Json }
    } catch {
        Send-Json -Response $Response -Status 400 `
            -Body @{ ok = $false; error = @{ code = 'bad_json'; detail = $_.Exception.Message } }
        return
    }
    if (-not $payload -or -not $payload.inReplyTo) {
        Send-Json -Response $Response -Status 400 `
            -Body @{ ok = $false; error = @{ code = 'missing_field'; detail = 'inReplyTo is required' } }
        return
    }

    # Outlook COM 取得 (起動中ならアタッチ、止まっていれば起動)
    $outlook = $null
    try {
        try { $outlook = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') }
        catch { $outlook = New-Object -ComObject Outlook.Application }
    } catch {
        Send-Json -Response $Response -Status 500 `
            -Body @{ ok = $false; error = @{ code = 'outlook_not_available'; detail = $_.Exception.Message } }
        return
    }

    # 元メール検索
    $orig = $null
    try {
        $orig = Find-OutlookMessageByInternetMessageId -Outlook $outlook -InternetMessageId $payload.inReplyTo
    } catch { }
    if (-not $orig) {
        Send-Json -Response $Response -Status 404 `
            -Body @{ ok = $false; error = @{ code = 'message_not_found'; detail = "InternetMessageId not found in any local Outlook store: $($payload.inReplyTo)" } }
        return
    }

    # 正規 Reply 下書きを生成 + 編集本文を冒頭に prepend + Cc 追記 + Display
    try {
        $reply = $orig.Reply()
        $bodyHtml = "$($payload.bodyHtml)"
        if ($bodyHtml) {
            # Outlook が自動生成する引用本文の上に prepend
            $reply.HTMLBody = $bodyHtml + $reply.HTMLBody
        }
        if ($payload.cc) {
            foreach ($addr in $payload.cc) {
                if ($addr) {
                    ($reply.Recipients.Add([string]$addr)).Type = 2  # olCC
                }
            }
            $null = $reply.Recipients.ResolveAll()
        }
        $reply.Display()
        Send-Json -Response $Response -Status 200 -Body @{ ok = $true }
    } catch {
        Send-Json -Response $Response -Status 500 `
            -Body @{ ok = $false; error = @{ code = 'outlook_reply_failed'; detail = $_.Exception.Message } }
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
