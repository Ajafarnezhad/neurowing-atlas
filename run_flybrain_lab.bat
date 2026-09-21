@echo off
setlocal
chcp 65001 >nul
if "%~1"=="" (
  echo Usage:
  echo   run_flybrain_lab.bat "D:\FAFB_v783"
  exit /b 1
)
if not exist .venv (
  python -m venv .venv
)
call .venv\Scripts\activate.bat
python -m pip install --upgrade pip
pip install -r requirements.txt
python app.py run --data "%~1"
pause
