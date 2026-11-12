#!/bin/sh
# Install (or update) the OpenCode Desktop side of huginn-voice on Windows, from WSL.
#
#   sh scripts/install-desktop.sh            from a clone in WSL
#
# OpenCode Desktop loads GUI plugins from its own Windows server, which reads only the Windows
# %USERPROFILE%\.config\opencode\opencode.json. So the script builds desktop/ here, copies the bundle to
# %USERPROFILE%\.local\share\huginn-voice-desktop, and lists that folder in the Windows config. The plugin's
# main process then runs bin/huginn-ear.py from this clone in WSL through wsl.exe.
#
# Needs bun (or node and npm) in WSL, and the key in ~/.config/huginn-voice/env or ~/.huginn-env.
set -e
src=$(cd "$(dirname "$0")/.." && pwd)

cmd=$(command -v cmd.exe || echo /mnt/c/Windows/System32/cmd.exe)
win_home=$(cd /mnt/c 2>/dev/null; "$cmd" /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')
[ -n "$win_home" ] || { echo "cmd.exe did not answer: run this in WSL" >&2; exit 1; }
home=$(wslpath "$win_home")
dest="$home/.local/share/huginn-voice-desktop"
cfg="$home/.config/opencode/opencode.json"

cd "$src/desktop"
if command -v bun >/dev/null 2>&1; then
  bun install --silent
  bun run build
else
  npm install --silent
  npm run build
fi

mkdir -p "$dest/dist" "$(dirname "$cfg")"
cp package.json "$dest/package.json"
cp dist/gui-experimental.cjs "$dest/dist/gui-experimental.cjs"

python3 - "$cfg" "$win_home\\.local\\share\\huginn-voice-desktop" "$src" <<'PY'
import json, sys
path, entry, clone = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    with open(path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {"$schema": "https://opencode.ai/config.json"}
def name(p):
    return p.get("package", "") if isinstance(p, dict) else p
keep, opts = [], None
for p in cfg.get("plugins", []):
    if "huginn-voice" in name(p):
        if isinstance(p, dict) and p.get("options"):
            opts = p["options"]    # keep the options already set
        continue
    keep.append(p)
opts = opts or {}
opts.setdefault("ear", clone + "/bin/huginn-ear.py")
keep.append({"package": entry, "options": opts})
cfg["plugins"] = keep
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f"{path}: huginn-voice -> {entry}")
PY

echo "Done. OpenCode Desktop reloads the plugin by itself; if the Huginn pill does not show above the prompt, restart the app."
