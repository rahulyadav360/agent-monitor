@echo off
rem One-time setup for agent-monitor on Windows. Safe to run again.
rem  1. checks Python  2. installs pywebview + psutil  3. creates your config (if missing)  4. adds Desktop and Start-menu shortcuts
setlocal EnableDelayedExpansion
set "HERE=%~dp0"
for %%I in ("%HERE%..") do set "REPO=%%~fI"
echo.
echo  agent-monitor for Windows - setup
echo  ---------------------------------

where python >nul 2>nul
if errorlevel 1 (
  echo  Python 3.9 or newer is needed. Install it from https://www.python.org/downloads/
  echo  and tick "Add python.exe to PATH" during setup. Then run this file again.
  pause
  exit /b 1
)
python -c "import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)"
if errorlevel 1 (
  echo  Your Python is older than 3.9. Install a newer one from https://www.python.org/downloads/
  pause
  exit /b 1
)

echo  Installing the two libraries the panel needs (pywebview, psutil)...
python -m pip install --user --upgrade --quiet pywebview psutil
if errorlevel 1 (
  echo  Could not install the libraries. Check your internet connection and run this file again.
  pause
  exit /b 1
)

set "CFGDIR=%USERPROFILE%\.config\agent-monitor"
set "CFG=%CFGDIR%\config.json"
if not exist "%CFGDIR%" mkdir "%CFGDIR%"
if not exist "%CFG%" (
  copy /y "%REPO%\examples\windows.config.json" "%CFG%" >nul
  echo  Created your config: %CFG%
  echo  It finds your running Claude Code and Codex work by itself. Optional settings: see README.
) else (
  echo  Keeping your existing config: %CFG%
)

for /f "delims=" %%P in ('python -c "import sys,os;print(os.path.join(os.path.dirname(sys.executable),'pythonw.exe'))"') do set "PYW=%%P"
if not exist "!PYW!" for /f "delims=" %%P in ('python -c "import sys;print(sys.executable)"') do set "PYW=%%P"

echo  Adding shortcuts "Agent Monitor" to the Desktop and Start menu...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$s = New-Object -ComObject WScript.Shell;" ^
  "foreach ($d in @([Environment]::GetFolderPath('Desktop'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'))) {" ^
  "  $l = $s.CreateShortcut((Join-Path $d 'Agent Monitor.lnk'));" ^
  "  $l.TargetPath = '!PYW!'; $l.Arguments = '\"%HERE%panel.py\"'; $l.WorkingDirectory = '%REPO%';" ^
  "  $l.Description = 'Floating panel: what your AI agents are doing'; $l.IconLocation = '%SystemRoot%\System32\imageres.dll,186'; $l.Save() }"

echo.
echo  Done. Double-click "Agent Monitor" on your Desktop to open the panel.
echo  (Ctrl+T switches layout, Ctrl+Shift+T switches light/dark.)
echo.
pause
endlocal
