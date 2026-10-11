#!/bin/sh
# Xcode Cloud post-clone hook. The .xcodeproj is generated from project.yml and
# not checked in (see ios/README.md), so create it before Xcode Cloud looks for
# ios/Empanadas.xcodeproj.
set -eu

cd "$(dirname "$0")/.."

if ! command -v xcodegen >/dev/null 2>&1; then
  # Xcode Cloud images ship with Homebrew.
  HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 brew install xcodegen
fi

xcodegen generate
test -d Empanadas.xcodeproj
