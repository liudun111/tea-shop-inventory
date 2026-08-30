@echo off
chcp 65001 >nul
cd /d %~dp0
title 茶店进销存
echo ========================================
echo    茶店进销存 正在启动...
echo    启动后浏览器将自动打开 http://localhost:8080
echo    所有数据自动保存到本机文件 data.json
echo    关闭本窗口即停止服务
echo ========================================
node server.js
pause
