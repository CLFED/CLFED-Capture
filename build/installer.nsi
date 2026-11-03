Unicode true
!include "MUI2.nsh"
!include "FileFunc.nsh"
Var Auto
!define APP "CLFED Capture"
Name "${APP}"
OutFile "../dist/CLFED-Capture-Setup-1.4.4.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP}.exe"
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipInAuto
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!define MUI_PAGE_CUSTOMFUNCTION_PRE SkipInAuto
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Arabic"
VIProductVersion "1.4.4.0"
VIAddVersionKey /LANG=${LANG_ARABIC} "ProductName" "${APP}"
VIAddVersionKey /LANG=${LANG_ARABIC} "FileDescription" "${APP} Setup"
VIAddVersionKey /LANG=${LANG_ARABIC} "CompanyName" "Talal (CLFED)"
VIAddVersionKey /LANG=${LANG_ARABIC} "LegalCopyright" "Talal (CLFED)"
VIAddVersionKey /LANG=${LANG_ARABIC} "FileVersion" "1.4.4"
Function .onInit
  ${GetParameters} $R0
  ClearErrors
  ${GetOptions} $R0 "/AUTO" $R1
  IfErrors +2
  StrCpy $Auto "1"
FunctionEnd
Function SkipInAuto
  StrCmp $Auto "1" 0 +2
  Abort
FunctionEnd
Section
  StrCmp $Auto "1" wait
  IfSilent wait stop
  wait:
  Sleep 2500
  stop:
  nsExec::Exec 'taskkill /IM "${APP}.exe" /F'
  nsExec::Exec `powershell -NoProfile -Command "Get-Process | Where-Object { $$_.Path -like '$INSTDIR\*' } | Stop-Process -Force"`
  Sleep 800
  SetOutPath "$INSTDIR"
  File /r "../dist/win-unpacked/*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  # A new icon file name makes Windows drop its cached picture on every update.
  Delete "$INSTDIR\clfed-*.ico"
  File "/oname=$INSTDIR\clfed-1.4.4.ico" "icon.ico"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${APP}.exe" "" "$INSTDIR\clfed-1.4.4.ico"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${APP}.exe" "" "$INSTDIR\clfed-1.4.4.ico"
  nsExec::Exec 'ie4uinit.exe -show'
  System::Call 'shell32::SHChangeNotify(i 0x08000000, i 0, p 0, p 0)'
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "DisplayName" "${APP}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "Publisher" "Talal (CLFED)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "DisplayVersion" "1.4.4"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "DisplayIcon" "$INSTDIR\clfed-1.4.4.ico"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  StrCmp $Auto "1" launch
  IfSilent launch done
  launch:
  Exec '"$INSTDIR\${APP}.exe"'
  SetAutoClose true
  done:
SectionEnd
Section "Uninstall"
  nsExec::Exec 'taskkill /IM "${APP}.exe" /F'
  Delete "$DESKTOP\${APP}.lnk"
  Delete "$SMPROGRAMS\${APP}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
SectionEnd
