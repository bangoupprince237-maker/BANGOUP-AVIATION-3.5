@echo off
chcp 65001 >nul
echo Installation (la premiere fois seulement)...
call npm install
echo.
echo Ouvrez votre navigateur sur : http://localhost:3000
start http://localhost:3000
node server.js
pause
