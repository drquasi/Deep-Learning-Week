@echo off
SETLOCAL
cd /d "%~dp0"

title fluentify Proxy Server
echo [fluentify Proxy] Starting...

:: Check if Node.js is installed
where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [fluentify Proxy] Node.js not found!
    echo [fluentify Proxy] Attempting to install Node.js via winget...
    
    :: Try winget directly first
    winget install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
    if %ERRORLEVEL% equ 0 goto node_installed
    if %ERRORLEVEL% equ -1978236880 goto node_installed
    
    :: Try absolute path to winget
    if exist "%LocalAppData%\Microsoft\WindowsApps\winget.exe" (
        "%LocalAppData%\Microsoft\WindowsApps\winget.exe" install OpenJS.NodeJS.LTS --silent --accept-package-agreements --accept-source-agreements
        if %ERRORLEVEL% equ 0 goto node_installed
        if %ERRORLEVEL% equ -1978236880 goto node_installed
    )
    
    :: As a final check, see if it was installed but not in PATH yet
    if exist "%ProgramFiles%\nodejs\node.exe" goto node_installed
    if exist "%ProgramFiles(x86)%\nodejs\node.exe" goto node_installed
    
    echo [fluentify Proxy] ERROR: Failed to install Node.js via winget.
    echo Please install Node.js manually from https://nodejs.org/
    pause
    exit /b

:node_installed
    echo [fluentify Proxy] Node.js is ready or already present.
    echo [fluentify Proxy] IMPORTANT: Please RESTART this terminal window to update your PATH.
    pause
    exit /b
)

:: Check if npm is installed
where npm >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo [fluentify Proxy] ERROR: npm not found even though Node.js is installed.
    echo Please ensure npm is in your PATH.
    pause
    exit /b
)

:: Check if node_modules exists, if not, install them
if not exist "node_modules\" (
    echo [fluentify Proxy] First time setup: Installing dependencies...
    call npm install
)

:: Check if .env exists
if not exist ".env" (
    echo [fluentify Proxy] WARNING: .env file not found! 
    echo Please enter your OpenAI API key in the .env file.
    copy .env.example .env
    pause
    exit /b
)

echo [fluentify Proxy] Running server...
call npm start
pause
