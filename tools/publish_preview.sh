#!/bin/sh
# Publish this checkout's webapp/ to the phone preview: https://mronchka.github.io/KeiserMagBridge-preview/
# (GitHub Pages of the repo mronchka/KeiserMagBridge-preview, served from its main branch).
# The live phone page (this repo's main, .github/workflows/pages.yml) is not touched.
#
#   sh tools/publish_preview.sh
#
# Bump APP_BUILD (and the stylesheet's ?v=) in webapp/index.html first, so phones fetch the new files.
# Note: the preview and the live page share the origin mronchka.github.io, so they share the phone's
# saved runs, resume record and theme.
set -e
ROOT=$(cd "$(dirname "$0")/.." && pwd)
REPO=https://github.com/mronchka/KeiserMagBridge-preview.git
BUILD=$(sed -n "s/.*var APP_BUILD = '\([^']*\)'.*/\1/p" "$ROOT/webapp/index.html")
SRC=$(git -C "$ROOT" rev-parse --short HEAD)$(git -C "$ROOT" diff --quiet -- webapp || echo "-dirty")
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git clone -q --depth 1 "$REPO" "$TMP/site" 2>/dev/null || { mkdir -p "$TMP/site"; git -C "$TMP/site" init -q -b main; git -C "$TMP/site" remote add origin "$REPO"; }
find "$TMP/site" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -R "$ROOT/webapp/." "$TMP/site/"
touch "$TMP/site/.nojekyll"   # serve the files as they are
cd "$TMP/site"
git add -A
if git diff --cached --quiet; then echo "preview already up to date ($BUILD)"; exit 0; fi
git commit -q -m "Preview $BUILD from KeiserMagBridge $SRC (branch $(git -C "$ROOT" rev-parse --abbrev-ref HEAD))"
git push -q origin HEAD:main
echo "published $BUILD ($SRC) -> https://mronchka.github.io/KeiserMagBridge-preview/"
