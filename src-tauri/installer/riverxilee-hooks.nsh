!macro NSIS_HOOK_PREINSTALL
  ; The branded outer installer passes the validated destination through this
  ; process-only environment value. This also handles paths containing spaces,
  ; which NSIS cannot reliably receive through a quoted /D argument.
  ReadEnvStr $R9 "RIVERXILEE_INSTALL_LOCATION"
  StrCmp $R9 "" +2 0
    StrCpy $INSTDIR $R9
!macroend
