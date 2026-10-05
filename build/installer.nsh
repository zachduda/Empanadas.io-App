!macro customInstallMode
	${if} $hasPerMachineInstallation == "1"
		StrCpy $isForceMachineInstall "1"
	${else}
		StrCpy $isForceCurrentInstall "1"
	${endif}
!macroend

!macro customWelcomePage
	!define MUI_WELCOMEPAGE_TITLE "Empanadas.io Application"
	!define MUI_WELCOMEPAGE_TEXT "Thanks for downloading the Empanadsas.io native desktop application! You'll be able to play games in full resolution, smoother, and without limits! Also sign in once, and never worry again, plus you can play your favorite games offline!$\r$\n$\r$\nClick Next to continue."
	!insertmacro skipPageIfUpdated
	!insertmacro MUI_PAGE_WELCOME
!macroend

; electron-builder's own Finish page, plus: an update does not stop on it.
!macro customFinishPage
	Function StartApp
		${if} ${isUpdated}
			StrCpy $1 "--updated"
		${else}
			StrCpy $1 ""
		${endif}
		${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "$1"
	FunctionEnd

	; Skipping the last page ends the installer, so an update reopens the app
	; and closes.
	Function finishPagePre
		${if} ${isUpdated}
			HideWindow
			Call StartApp
			Abort
		${endif}
	FunctionEnd

	!define MUI_PAGE_CUSTOMFUNCTION_PRE finishPagePre
	!define MUI_FINISHPAGE_TITLE "Your Empanada's Finished Baking!"
	!define MUI_FINISHPAGE_TEXT "Great news! Empanadas.io is now finished up and ready to go!"
	!define MUI_FINISHPAGE_RUN
	!define MUI_FINISHPAGE_RUN_TEXT "Great! Launch it."
	!define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
	!insertmacro MUI_PAGE_FINISH
!macroend
