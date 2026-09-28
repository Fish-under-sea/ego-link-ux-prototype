@echo off
chcp 65001 >nul
cd /d "%~dp0"
title ESP32-S3-EYE 三轴传感器监控（本机服务器）

rem 优先用 PATH 里的 node；找不到再退回 WorkBuddy 托管的 node。
rem ★ 托管运行时升级后版本目录名会变（如 22.22.2-2 → 22.22.2-3），
rem   所以这里**动态查找**而不是写死版本号 —— 写死会在升级后静默失效。
set "NODE_BIN="
for /d %%d in ("%USERPROFILE%\.workbuddy-ai\binaries\node\versions\*") do (
  if exist "%%d\node.exe" set "NODE_BIN=%%d\node.exe"
)

echo.
echo   启动本机服务器（电脑即服务器，不依赖 VPS）…
echo   控制台会打印"局域网访问"地址，把它填进固件 app_config.h 的 APP_SERVER_HOST。
echo.

rem 2 秒后自动打开浏览器
start "" /b cmd /c "timeout /t 2 >nul & start "" http://127.0.0.1:8080"

where node >nul 2>nul
if %errorlevel%==0 (
  node server.js
) else if exist "%NODE_BIN%" (
  "%NODE_BIN%" server.js
) else (
  echo 未找到 Node.js，请先安装 Node.js 18 或更高版本： https://nodejs.org
)

pause
