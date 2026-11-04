; Регистрация Vanium как веб-браузера в Windows: он появится в «Параметры → Приложения по умолчанию».
; Установка для текущего пользователя (perMachine: false), поэтому пишем в HKCU.
!macro customInstall
  WriteRegStr HKCU "Software\Classes\VaniumHTML" "" "Vanium HTML Document"
  WriteRegStr HKCU "Software\Classes\VaniumHTML\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Classes\VaniumHTML\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}" "%1"'

  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Vanium" "" "Vanium"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Vanium\DefaultIcon" "" "$INSTDIR\${APP_EXECUTABLE_FILENAME},0"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Vanium\shell\open\command" "" '"$INSTDIR\${APP_EXECUTABLE_FILENAME}"'
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Vanium\Capabilities" "ApplicationName" "Vanium"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Vanium\Capabilities" "ApplicationDescription" "Vanium - fast minimalist browser"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Vanium\Capabilities\URLAssociations" "http" "VaniumHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Vanium\Capabilities\URLAssociations" "https" "VaniumHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Vanium\Capabilities\FileAssociations" ".htm" "VaniumHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Vanium\Capabilities\FileAssociations" ".html" "VaniumHTML"
  WriteRegStr HKCU "Software\Clients\StartMenuInternet\Vanium\Capabilities\FileAssociations" ".xhtml" "VaniumHTML"
  WriteRegStr HKCU "Software\RegisteredApplications" "Vanium" "Software\Clients\StartMenuInternet\Vanium\Capabilities"
!macroend

!macro customUnInstall
  DeleteRegKey HKCU "Software\Clients\StartMenuInternet\Vanium"
  DeleteRegValue HKCU "Software\RegisteredApplications" "Vanium"
  DeleteRegKey HKCU "Software\Classes\VaniumHTML"
!macroend
