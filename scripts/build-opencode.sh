#!/bin/sh
# Rebuild opencode/huginn-voice.js from opencode/huginn-voice.tsx. OpenCode compiles a plugin's JSX
# only for plugin files outside node_modules, and an installed plugin lives under node_modules, so
# the package ships plain JS. Run this after every change to the .tsx and commit both files.
set -e
here=$(cd "$(dirname "$0")/.." && pwd)
tmp=$(mktemp -d)
cp "$here/scripts/build-opencode.cjs" "$tmp/"
(cd "$tmp" && npm i -s --no-save @babel/core@7.26.0 @babel/preset-typescript@7.26.0 babel-preset-solid@1.9.3 >/dev/null)
node "$tmp/build-opencode.cjs" "$here/opencode/huginn-voice.tsx" "$here/opencode/huginn-voice.js"
rm -rf "$tmp"
echo "built opencode/huginn-voice.js"
