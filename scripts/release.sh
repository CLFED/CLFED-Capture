#!/usr/bin/env bash
# Builds the Windows installer and publishes it so installed copies offer the update.
# Run after raising the version in package.json, build/installer.nsi, and build/afterPack.js.
set -euo pipefail
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
NSIS=$HOME/.cache/electron-builder/nsis/nsis-3.0.4.1
REPO=CLFED/CLFED-Capture

npm ci --no-audit --no-fund
mkdir -p build/bin
npm_config_platform=win32 npm_config_arch=x64 node node_modules/ffmpeg-static/install.js
cp node_modules/ffmpeg-static/ffmpeg.exe build/bin/ffmpeg.exe
python3 -m ziglang c++ -target x86_64-windows-gnu -O2 -municode -s -static native/audio-helper.cpp -o build/bin/clfed-audio.exe -lole32 -luuid
rm -rf dist
npx electron-builder --win --x64 --dir
(cd build && NSISDIR="$NSIS" "$NSIS/linux/makensis" -V2 installer.nsi)

SHA=$(sha256sum dist/CLFED-Capture-Setup.exe | cut -d' ' -f1)
cat > dist/latest.json <<JSON
{"version":"$VERSION","url":"https://github.com/$REPO/releases/download/v$VERSION/CLFED-Capture-Setup.exe","sha256":"$SHA"}
JSON
gh release create "v$VERSION" dist/CLFED-Capture-Setup.exe dist/latest.json --repo "$REPO" --title "CLFED Capture $VERSION" --notes "CLFED Capture $VERSION"
