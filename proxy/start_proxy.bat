@echo off
SETLOCAL
cd /d "%~dp0"

echo [AdaptiRead Proxy] Starting...

:: Check if node_modules exists, if not, install them
if not exist "node_modules\" (
    echo [AdaptiRead Proxy] First time setup: Installing dependencies...
    call npm install
)

:: Check if .env exists
if not exist ".env" (
    echo [AdaptiRead Proxy] WARNING: .env file not found! 
    echo Please enter your OpenAI API key in the .env file.
    copy .env.example .env
    pause
    exit /b
)

echo [AdaptiRead Proxy] Running server...
call npm start
pause
