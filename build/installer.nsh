; Visual VPS Manager — NSIS customization
; Upgrade path: close the running app, then REPLACE the old files.
; NOTE: we do NOT run the old uninstaller in-place here — assisted installers
; already overwrite app files; running the old uninstaller would delete the
; freshly-copied files (the "installer does nothing" bug). Uninstall entries
; are replaced automatically by the new install.
; User data (profiles, encrypted vault, host keys) lives in %APPDATA% and is
; always preserved.

!macro customInit
  DetailPrint "Closing any running instance…"
  nsExec::ExecToLog 'taskkill /F /IM "Visual VPS Manager.exe" /T'
  nsExec::ExecToLog 'taskkill /F /IM "VisualVPSManager-Portable.exe" /T'
  Sleep 800
!macroend

!macro customInstall
  ; nothing extra — shortcuts + run-after-finish are handled by the assisted UI
!macroend
