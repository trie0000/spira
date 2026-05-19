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
    Write-Host ''
    Write-Host 'エラー: ゲートウェイ URL が未指定です。' -ForegroundColor Red
    Write-Host '  -Target https://gateway.example.com/myapi'
    Write-Host '  または環境変数 SPIRA_AI_TARGET で指定してください。'
    Write-Host ''
    exit 1
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

$Target = $Target.TrimEnd('/')
$targetUri = [Uri]$Target
$targetPath = $targetUri.AbsolutePath  # 例: "/myapi"
if ($targetPath -eq '/') { $targetPath = '' }

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
Write-Host '  Spira AI relay (PowerShell)'
Write-Host ('─' * 72)
Write-Host "  listen  : http://127.0.0.1:$Port"
Write-Host "  target  : $Target"
Write-Host "  proxy   : $(if ($NoProxy -or -not $Proxy) { '(直接接続)' } else { $Proxy })"
if ($SkipCertCheck) { Write-Host '  ⚠ SSL 検証スキップ中 (-SkipCertCheck)' -ForegroundColor Yellow }
Write-Host ('─' * 72)
Write-Host 'Spira の「AI 設定」モーダルでベース URL に下記いずれかを入力:'
Write-Host "  A: $baseUrlShort"
if ($baseUrlShort -ne $baseUrlMirror) {
    Write-Host "  B: $baseUrlMirror    (実 URL のパスを保ったまま localhost に置換、視認性◎)"
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
