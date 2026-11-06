#!/usr/bin/env bash
# Build dist/openmaestri_<version>_<arch>.deb from the working tree.
#   scripts/build-deb.sh            -> dist/openmaestri_<ver>_amd64.deb
# Needs: node >= 22, npm, a C++ toolchain (node-pty compiles on install), dpkg-deb.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="$(node -p "require('./package.json').version")"
ARCH="$(dpkg --print-architecture)"
PKG="openmaestri_${VERSION}_${ARCH}"
STAGE="$(mktemp -d)"
trap 'rm -rf "$STAGE"' EXIT
APP="$STAGE/$PKG/usr/lib/openmaestri"

mkdir -p "$APP" "$STAGE/$PKG/DEBIAN" "$STAGE/$PKG/usr/bin" \
         "$STAGE/$PKG/usr/share/applications" "$STAGE/$PKG/usr/share/icons/hicolor/scalable/apps" \
         "$STAGE/$PKG/usr/share/doc/openmaestri"

cp -r src bin web desktop assets package.json package-lock.json LICENSE "$APP/"
mkdir -p "$APP/test" && cp -r test/challenge "$APP/test/" # the harness `openmaestri selftest` uses
rm -rf "$APP/desktop/node_modules"
# production dependencies only; node-pty compiles here
( cd "$APP" && npm ci --omit=dev --no-audit --no-fund >/dev/null )
# drop what the runtime never loads (sources, build intermediates, maps)
find "$APP/node_modules" \( -name '*.map' -o -name '*.md' -o -name 'test' -o -name 'tests' \) -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$APP/node_modules/node-pty/build/Release/obj.target" "$APP/node_modules/node-pty/build/Release/.deps" \
       "$APP/node_modules/node-pty/src" "$APP/node_modules/node-pty/deps" "$APP/node_modules/node-pty/prebuilds" 2>/dev/null || true
test -f "$APP/node_modules/node-pty/build/Release/pty.node" || { echo "node-pty native module missing" >&2; exit 1; }

cat > "$STAGE/$PKG/usr/bin/openmaestri" <<'LAUNCH'
#!/bin/sh
exec node /usr/lib/openmaestri/bin/openmaestri.js "$@"
LAUNCH
chmod 755 "$STAGE/$PKG/usr/bin/openmaestri"
chmod 755 "$APP/bin/openmaestri.js" "$APP/bin/shims/openmaestri"

install -m 644 packaging/openmaestri.desktop "$STAGE/$PKG/usr/share/applications/openmaestri.desktop"
install -m 644 assets/icon.svg "$STAGE/$PKG/usr/share/icons/hicolor/scalable/apps/openmaestri.svg"
install -m 644 LICENSE "$STAGE/$PKG/usr/share/doc/openmaestri/copyright"

SIZE_KB="$(du -sk "$STAGE/$PKG/usr" | cut -f1)"
cat > "$STAGE/$PKG/DEBIAN/control" <<CTRL
Package: openmaestri
Version: ${VERSION}
Section: devel
Priority: optional
Architecture: ${ARCH}
Depends: nodejs (>= 22)
Recommends: git, xdg-utils, chromium | chromium-browser | google-chrome-stable
Installed-Size: ${SIZE_KB}
Maintainer: openmaestri contributors <https://github.com/baduba/openmaestri/issues>
Homepage: https://github.com/baduba/openmaestri
Description: Spatial canvas terminal workspace for AI agents
 openmaestri puts AI coding agents (OpenCode, Claude Code, Codex, Aider, ...) on an
 infinite canvas, wires them to notes and to each other, and lets one "Maestro"
 agent orchestrate the rest through the openmaestri CLI. Works with open models
 such as DeepSeek. Open source implementation; not affiliated with Maestri.
CTRL

mkdir -p dist
dpkg-deb --root-owner-group -Zxz -b "$STAGE/$PKG" "dist/${PKG}.deb" >/dev/null
echo "built dist/${PKG}.deb ($(du -h "dist/${PKG}.deb" | cut -f1))"
