@echo off
setlocal EnableExtensions

cd /d "%~dp0"

if "%EDGE_INTERVAL_SECONDS%"=="" set "EDGE_INTERVAL_SECONDS=300"
if "%EDGE_RETRY_SECONDS%"=="" set "EDGE_RETRY_SECONDS=20"

if not "%PYTHON_CMD%"=="" (
  %PYTHON_CMD% --version >nul 2>&1
  if errorlevel 1 (
    echo [edge.bat] Requested PYTHON_CMD=%PYTHON_CMD% is not runnable, auto-fixing...
    set "PYTHON_CMD="
  )
)

if "%PYTHON_CMD%"=="" (
  uv --version >nul 2>&1
  if errorlevel 1 (
    set "PYTHON_CMD=python"
  ) else (
    set "PYTHON_CMD=uv"
  )
)

if /I "%PYTHON_CMD%"=="python" (
  python -c "import perplexity_webui_scraper" >nul 2>&1
  if errorlevel 1 (
    echo [edge.bat] Missing Python dependency: perplexity_webui_scraper
    echo [edge.bat] Install once with:
    echo [edge.bat]   python -m pip install perplexity-webui-scraper
    exit /b 2
  )
)

if /I "%~1"=="once" goto run_once

echo [edge.bat] Autorun mode started. interval=%EDGE_INTERVAL_SECONDS%s retry=%EDGE_RETRY_SECONDS%s python=%PYTHON_CMD%

:loop
echo [edge.bat] Running scanner at %date% %time%
node edge/edge_scanner.mjs
set "CODE=%ERRORLEVEL%"
if "%CODE%"=="0" (
  echo [edge.bat] Scan finished OK. Sleeping %EDGE_INTERVAL_SECONDS%s...
  timeout /t %EDGE_INTERVAL_SECONDS% /nobreak >nul
) else (
  echo [edge.bat] Scan failed with code %CODE%. Retrying in %EDGE_RETRY_SECONDS%s...
  timeout /t %EDGE_RETRY_SECONDS% /nobreak >nul
)
goto loop

:run_once
echo [edge.bat] Single run mode python=%PYTHON_CMD%
node edge/edge_scanner.mjs
exit /b %ERRORLEVEL%
