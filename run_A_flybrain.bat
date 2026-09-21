@echo off
chcp 65001 >nul
title FlyBrain Learning Lab 3.1.1
echo ==============================================
echo FlyBrain Learning Lab 3.1.1 - A:\flybrain
echo ==============================================
echo.
python app.py run --data "A:\flybrain" --no-prepare
pause
