!macro NSIS_HOOK_PREINSTALL
  IfFileExists "$INSTDIR\runtime\node_modules\better-sqlite3\prebuilds\win32-x64.node" 0 dsm_no_existing_native_module
  DetailPrint "Closing the existing Degree Study Manager backend..."
  !insertmacro RestartManager_ShutdownFile "$INSTDIR\runtime\node_modules\better-sqlite3\prebuilds\win32-x64.node" $0
  ${If} $0 != 0
    MessageBox MB_ICONSTOP|MB_OK "Windows could not close the existing Degree Study Manager backend. Close the app and retry the installation."
    Abort
  ${EndIf}
  dsm_no_existing_native_module:
!macroend
