Unicode true
!include "MUI2.nsh"
!define APP "CLFED Capture"
Name "${APP}"
OutFile "../dist/CLFED-Capture-Setup-1.4.1.exe"
InstallDir "$LOCALAPPDATA\Programs\${APP}"
InstallDirRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "InstallLocation"
RequestExecutionLevel user
SetCompressor /SOLID lzma
!define MUI_ICON "icon.ico"
!define MUI_UNICON "icon.ico"
!define MUI_FINISHPAGE_RUN "$INSTDIR\${APP}.exe"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Arabic"
VIProductVersion "1.4.1.0"
VIAddVersionKey /LANG=${LANG_ARABIC} "ProductName" "${APP}"
VIAddVersionKey /LANG=${LANG_ARABIC} "FileDescription" "${APP} Setup"
VIAddVersionKey /LANG=${LANG_ARABIC} "CompanyName" "Talal (CLFED)"
VIAddVersionKey /LANG=${LANG_ARABIC} "LegalCopyright" "Talal (CLFED)"
VIAddVersionKey /LANG=${LANG_ARABIC} "FileVersion" "1.4.1"
Section
  IfSilent 0 +2
  Sleep 2500
  nsExec::Exec 'taskkill /IM "${APP}.exe" /F'
  SetOutPath "$INSTDIR"
  File /r "../dist/win-unpacked/*.*"
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  CreateShortcut "$DESKTOP\${APP}.lnk" "$INSTDIR\${APP}.exe"
  CreateShortcut "$SMPROGRAMS\${APP}.lnk" "$INSTDIR\${APP}.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "DisplayName" "${APP}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "Publisher" "Talal (CLFED)"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "DisplayVersion" "1.4.1"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "DisplayIcon" "$INSTDIR\${APP}.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}" "UninstallString" "$\"$INSTDIR\Uninstall.exe$\""
  IfSilent 0 +2
  Exec '"$INSTDIR\${APP}.exe"'
SectionEnd
Section "Uninstall"
  nsExec::Exec 'taskkill /IM "${APP}.exe" /F'
  Delete "$DESKTOP\${APP}.lnk"
  Delete "$SMPROGRAMS\${APP}.lnk"
  RMDir /r "$INSTDIR"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APP}"
SectionEnd
