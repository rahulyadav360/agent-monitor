@echo off
rem Open the agent-monitor panel. Close its window to stop it.
rem   start.bat [config.json]   (default: %AGENT_MONITOR_CONFIG% or %USERPROFILE%\.config\agent-monitor\config.json)
setlocal
set "HERE=%~dp0"
where pythonw >nul 2>nul
if errorlevel 1 (
  echo Python was not found. Run install.bat first.
  pause
  exit /b 1
)
start "" pythonw "%HERE%panel.py" %*
endlocal
