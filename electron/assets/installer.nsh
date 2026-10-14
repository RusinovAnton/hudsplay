; Extra installer steps (electron-builder NSIS include).

; The installer closes a running racehud.exe before (re)installing; its backend runs as a
; separate process and would keep the files locked, so stop it too.
!macro customInit
  nsExec::Exec 'taskkill /F /IM racehud-backend.exe'
!macroend

!macro customUnInit
  nsExec::Exec 'taskkill /F /IM racehud-backend.exe'
!macroend

; "Start with Windows" (tray menu) is a Run value named after the app id; drop it on
; uninstall. Settings, maps and layout in %APPDATA%\racehud are kept.
!macro customUnInstall
  DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
!macroend
