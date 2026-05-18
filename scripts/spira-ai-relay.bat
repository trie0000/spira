@echo off
REM ============================================================================
REM Spira AI relay launcher (Windows / Pure PowerShell)
REM ============================================================================
REM
REM 設定は同じフォルダの `spira-ai-relay.env` に書きます。
REM 初回セットアップ:
REM   copy spira-ai-relay.env.example spira-ai-relay.env
REM   notepad spira-ai-relay.env
REM
REM この .bat はダブルクリックで起動するための薄い wrapper です。
REM タスクスケジューラの「ログオン時」トリガで自動起動も可。
REM ============================================================================

REM ExecutionPolicy の影響を避けるため `-ExecutionPolicy Bypass` で実行。
REM スクリプト自体はリポジトリ同梱のローカル ファイル。
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0spira-ai-relay.ps1" %*
pause
