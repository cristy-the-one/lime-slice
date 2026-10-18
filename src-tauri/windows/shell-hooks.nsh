; Explorer thumbnail and preview for .lime. Per-user installs write HKCU because
; these keys are under SHCTX. This does not replace Tauri's open verb, and it
; does not start another program.

!macro NSIS_HOOK_POSTINSTALL
  WriteRegStr SHCTX "Software\Classes\CLSID\{A344EC17-8764-5F01-9C73-FFE2DA751916}" "" "Lime Slice project"
  WriteRegStr SHCTX "Software\Classes\CLSID\{A344EC17-8764-5F01-9C73-FFE2DA751916}\InprocServer32" "" "$INSTDIR\lime_shell.dll"
  WriteRegStr SHCTX "Software\Classes\CLSID\{A344EC17-8764-5F01-9C73-FFE2DA751916}\InprocServer32" "ThreadingModel" "Apartment"
  WriteRegStr SHCTX "Software\Classes\CLSID\{A344EC17-8764-5F01-9C73-FFE2DA751916}\InprocServer32" "AppID" "{6d2b5079-2f0b-48dd-ab7f-97cec514d30b}"
  WriteRegStr SHCTX "Software\Classes\com.limeslice.slicer.lime\shellex\{e357fccd-a995-4576-b01f-234630154e96}" "" "{A344EC17-8764-5F01-9C73-FFE2DA751916}"
  WriteRegStr SHCTX "Software\Classes\com.limeslice.slicer.lime\shellex\{8895b1c6-b41f-4c1c-a562-0d564250836f}" "" "{A344EC17-8764-5F01-9C73-FFE2DA751916}"
  WriteRegStr SHCTX "Software\Classes\SystemFileAssociations\.lime\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}" "" "{A344EC17-8764-5F01-9C73-FFE2DA751916}"
  WriteRegStr SHCTX "Software\Classes\.lime\ShellEx\{8895b1c6-b41f-4c1c-a562-0d564250836f}" "" "{A344EC17-8764-5F01-9C73-FFE2DA751916}"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\PreviewHandlers" "{A344EC17-8764-5F01-9C73-FFE2DA751916}" "Lime Slice project"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\PropertySystem\PropertyHandlers\.lime" "" "{A344EC17-8764-5F01-9C73-FFE2DA751916}"
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  DeleteRegKey SHCTX "Software\Classes\CLSID\{A344EC17-8764-5F01-9C73-FFE2DA751916}"
  DeleteRegKey SHCTX "Software\Classes\com.limeslice.slicer.lime\shellex\{e357fccd-a995-4576-b01f-234630154e96}"
  DeleteRegKey SHCTX "Software\Classes\com.limeslice.slicer.lime\shellex\{8895b1c6-b41f-4c1c-a562-0d564250836f}"
  DeleteRegKey SHCTX "Software\Classes\SystemFileAssociations\.lime\ShellEx\{e357fccd-a995-4576-b01f-234630154e96}"
  DeleteRegKey SHCTX "Software\Classes\.lime\ShellEx\{8895b1c6-b41f-4c1c-a562-0d564250836f}"
  DeleteRegValue SHCTX "Software\Microsoft\Windows\CurrentVersion\PreviewHandlers" "{A344EC17-8764-5F01-9C73-FFE2DA751916}"
  DeleteRegKey SHCTX "Software\Microsoft\Windows\CurrentVersion\PropertySystem\PropertyHandlers\.lime"
!macroend
