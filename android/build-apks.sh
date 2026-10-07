#!/usr/bin/env bash
# Builds the games for the web, bundles each into its Android flavour, and
# assembles one release APK per game into android/out/. Needs Node 22, JDK 17 and the
# Android SDK (ANDROID_HOME, or sdk.dir in android/local.properties).
# Bash only; on Windows run it from Git Bash or WSL.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
android="$root/android"

bundle() { # <game folder> <flavour>
  local game="$1" flavour="$2"
  echo "── $game: web build"
  (cd "$root/$game" && npm ci && npm run build)
  local dest="$android/app/src/$flavour/assets/game"
  rm -rf "$dest"
  mkdir -p "$dest"
  cp -R "$root/$game/dist/." "$dest/"
}

bundle field-line fieldLine
bundle castaway-lagoon castawayLagoon
bundle contrail contrail
bundle ridgeline ridgeline
bundle tanks tanks

echo "── Android: assembleRelease"
cd "$android"
if [ -x ./gradlew ]; then ./gradlew --no-daemon assembleRelease; else gradle --no-daemon assembleRelease; fi

mkdir -p out
cp app/build/outputs/apk/fieldLine/release/app-fieldLine-release.apk out/field-line.apk
cp app/build/outputs/apk/castawayLagoon/release/app-castawayLagoon-release.apk out/castaway-lagoon.apk
cp app/build/outputs/apk/contrail/release/app-contrail-release.apk out/contrail.apk
cp app/build/outputs/apk/ridgeline/release/app-ridgeline-release.apk out/ridgeline.apk
cp app/build/outputs/apk/tanks/release/app-tanks-release.apk out/tanks.apk
ls -l out/*.apk
