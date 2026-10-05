; Included by electron-builder's assisted (wizard) installer - see build.nsis
; in package.json. The artwork it shows is build/installerSidebar.bmp and
; build/installerHeader.bmp, drawn by scripts/installer-art.py.
;
; A first install is a short wizard: Welcome, the progress bar, Finish. An
; update is none of that. The app's updater (updater.js) starts the installer
; with --updated and quits, and that run skips straight to installing and then
; reopens the app, as the old one-click installer did, with nothing to click.

; Install where it is already installed, and never ask. The one-click
; installer was always per-user, so that is where a new install goes too; an
; older per-machine install stays per-machine, since that is where its
; shortcuts and uninstaller are. Without this the wizard opens with an
; "Anyone who uses this computer / Only for me" page, and shows it during an
; update as well.
!macro customInstallMode
	${if} $hasPerMachineInstallation == "1"
		StrCpy $isForceMachineInstall "1"
	${else}
		StrCpy $isForceCurrentInstall "1"
	${endif}
!macroend

!macro customWelcomePage
	!define MUI_WELCOMEPAGE_TITLE "Welcome to Empanadas.io"
	!define MUI_WELCOMEPAGE_TEXT "Setup will install Empanadas.io on your computer: Spin, Flappy Empanada and your account, in an app of their own.$\r$\n$\r$\nClick Next to continue."
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
	!define MUI_FINISHPAGE_TITLE "Empanadas.io is ready"
	!define MUI_FINISHPAGE_TEXT "Empanadas.io is installed. You'll find it on your desktop and in the Start menu."
	!define MUI_FINISHPAGE_RUN
	!define MUI_FINISHPAGE_RUN_TEXT "Open Empanadas.io now"
	!define MUI_FINISHPAGE_RUN_FUNCTION "StartApp"
	!insertmacro MUI_PAGE_FINISH
!macroend
