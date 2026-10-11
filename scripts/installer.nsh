; scripts/installer.nsh
; 由 electron-builder.yml 的 nsis.include 挂入。
;
; 背景：升级安装时 electron-builder 会先运行旧版卸载器并清空安装目录，
; 该过程会调用 WinShell::UninstAppUserModelId / UninstShortcut，
; 清除任务栏固定项等系统级状态，导致用户每次升级后都要重新固定。
;
; 方案（稳定启动器）：
;   安装一个独立的小启动器 exe 到固定目录（升级/卸载流程不会清空该目录），
;   桌面与开始菜单快捷方式指向它，用户固定的是它；它再读取同目录 app-path.txt，
;   拉起真正安装目录下的主程序。这样主程序目录被重建不影响已固定的启动器。
;
; 说明：
;   - 快捷方式改由本脚本创建（yml 中 createDesktopShortcut/createStartMenuShortcut 关闭）。
;   - 快捷方式 AUMID 与主程序一致（${APP_ID}），保证运行中的窗口与固定项归为一组。
;   - 升级（--updated）时保留启动器；仅真正卸载时清理。

!define WA_LAUNCHER_NAME "WorkAvatarLauncher.exe"
!define WA_APP_PATH_FILE "app-path.txt"

!macro customInstall
  ; 启动器固定目录：按安装模式取当前用户 / 所有用户的稳定位置
  ${if} $installMode == "all"
    SetShellVarContext all
    StrCpy $R9 "$APPDATA\WorkAvatarLauncher"
  ${else}
    SetShellVarContext current
    StrCpy $R9 "$LOCALAPPDATA\WorkAvatarLauncher"
  ${endIf}
  CreateDirectory "$R9"

  ; 释放启动器（升级时覆盖同名文件，路径不变，不影响已有固定项）
  SetOutPath "$R9"
  File "/oname=${WA_LAUNCHER_NAME}" "${PROJECT_DIR}\resources\launcher\${WA_LAUNCHER_NAME}"

  ; 记录主程序路径，供启动器拉起（UTF-16LE，避免非 ASCII 用户名/路径乱码）
  FileOpen $R8 "$R9\${WA_APP_PATH_FILE}" w
  FileWriteUTF16LE $R8 "$INSTDIR\${APP_EXECUTABLE_FILENAME}"
  FileClose $R8

  ; 重建快捷方式，指向启动器
  CreateShortCut "$DESKTOP\${SHORTCUT_NAME}.lnk" "$R9\${WA_LAUNCHER_NAME}" "" "$R9\${WA_LAUNCHER_NAME}" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$DESKTOP\${SHORTCUT_NAME}.lnk" "${APP_ID}"
  CreateShortCut "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "$R9\${WA_LAUNCHER_NAME}" "" "$R9\${WA_LAUNCHER_NAME}" 0 "" "" "${APP_DESCRIPTION}"
  WinShell::SetLnkAUMI "$SMPROGRAMS\${SHORTCUT_NAME}.lnk" "${APP_ID}"

  ; 通知 Shell 刷新图标
  System::Call 'shell32::SHChangeNotify(i, i, i, i) v (0x08000000, 0, 0, 0)'

  ; 清理 electron-builder 生成的 electron-updater 缓存目录（%LOCALAPPDATA%\workavatar-updater，
  ; 安装时会把安装器自身拷一份进去，本项目未使用自动更新，属无用占用，安装完即删）
  SetShellVarContext current
  RMDir /r "$LOCALAPPDATA\workavatar-updater"
  ${if} $installMode == "all"
    SetShellVarContext all
  ${endIf}

  SetOutPath $INSTDIR
!macroend

!macro customUnInstall
  ; 仅真正卸载时清理；升级（--updated）保留启动器，以维持任务栏固定项
  ${ifNot} ${isUpdated}
    Delete "$DESKTOP\${SHORTCUT_NAME}.lnk"
    Delete "$SMPROGRAMS\${SHORTCUT_NAME}.lnk"
    ${if} $installMode == "all"
      SetShellVarContext all
      RMDir /r "$APPDATA\WorkAvatarLauncher"
      SetShellVarContext current
    ${else}
      RMDir /r "$LOCALAPPDATA\WorkAvatarLauncher"
    ${endIf}
    RMDir /r "$LOCALAPPDATA\workavatar-updater"
  ${endIf}
!macroend
