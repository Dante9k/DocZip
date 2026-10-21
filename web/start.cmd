@echo off
chcp 65001 >nul
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" "scripts\serve.mjs" --open
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo 请使用包含 runtime 文件夹的完整本地网页版压缩包。
    pause
    exit /b 1
  )
  node "scripts\serve.mjs" --open
)
if errorlevel 1 pause
