; Override electron-builder's default app-running check with an aggressive
; force-kill. Default taskkill /im sometimes leaves Electron helper processes
; or locked DLLs in place long enough to break file replacement during
; install/uninstall. /F = force, /T = kill tree (children too).
!macro customCheckAppRunning
  nsExec::Exec `taskkill /F /T /IM "${APP_EXECUTABLE_FILENAME}"`
  Pop $0
  Sleep 1500
!macroend
