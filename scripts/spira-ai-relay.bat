@echo off
REM ============================================================================
REM Spira AI relay launcher (Windows / Pure PowerShell)
REM ============================================================================
REM
REM 1) 環境変数を編集 (この .bat に直書きする想定。秘密情報を入れないこと):
REM    - SPIRA_AI_TARGET : 社内 AI ゲートウェイの URL
REM    - SPIRA_AI_PROXY  : オンプレ プロキシの URL (不要なら空のまま)
REM    - SPIRA_AI_PORT   : ローカル listen ポート (既定 18080)
REM
REM 2) この .bat をダブルクリックで起動。
REM    タスクスケジューラの「ログオン時」トリガで自動起動も可。
REM ============================================================================

set "SPIRA_AI_TARGET=https://gateway.example.com/myapi"
set "SPIRA_AI_PROXY=http://onprem-proxy.example.com:8080"
set "SPIRA_AI_PORT=18080"

REM ExecutionPolicy の影響を避けるため `-ExecutionPolicy Bypass` で実行。
REM スクリプト自体はリモート署名されていないローカルファイル扱い。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0spira-ai-relay.ps1" %*
pause
