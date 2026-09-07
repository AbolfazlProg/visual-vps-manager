; Visual VPS Manager — custom NSIS installer customization
; Ensures a clean upgrade path from any previous installation:
;  1. kills the running app (old installed copy OR portable launcher)
;  2. uninstalls the previous version in place (keeps user data in %APPDATA%)
;  3. refreshes shortcuts
; User data (profiles, encrypted vault, host keys, activity log) lives in
; %APPDATA%\visual-vps-manager and is intentionally preserved across updates.

!macro customInit
  ; close a running instance so files can be replaced
  nsExec::ExecToLog 'taskkill /F /IM "Visual VPS Manager.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "VisualVPSManager-Portable.exe" /T'
  Sleep 600
!macroend

!macro customInstall
  ; run the previous uninstaller silently if present (one-click installs store
  ; it next to the app); /CURRENTUSER matches electron-builder's per-user mode
  IfFileExists "$INSTDIR\Uninstall Visual VPS Manager.exe" 0 +2
    ExecWait '"$INSTDIR\Uninstall Visual VPS Manager.exe" /S _?=$INSTDIR'
!macroend

!macro customUnInstall
  ; keep %APPDATA% user data — profiles & encrypted credentials survive updates
!macroend
