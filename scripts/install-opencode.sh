#!/bin/sh
# Install (or update) the OpenCode side of huginn-voice for this user.
#
#   sh scripts/install-opencode.sh          from a clone of github.com/morphem/huginn-voice
#
# OpenCode 2.x loads TUI plugins from ~/.config/opencode/cli.json (the opencode2/ directory);
# OpenCode 1.x loads them from ~/.config/opencode/tui.json (opencode/huginn-voice.js). Its own installer
# (`opencode plugin github:…`) puts the package in a cache directory named `github:morphem` and a
# plugin under a path with a colon in it does not load (OpenCode 1.18.33), so this points tui.json
# at the file in a plain clone instead. Updating is `git pull` in that clone; this script does it.
#
# It also moves Huginn's older OpenCode integration (/huginn and /huginn-refine as markdown commands,
# plugins/huginn.ts) to a backup folder, because both register /huginn.
set -e
src=$(cd "$(dirname "$0")/.." && pwd)
cfg="${XDG_CONFIG_HOME:-$HOME/.config}/opencode"
mkdir -p "$cfg"

git -C "$src" pull -q --ff-only 2>/dev/null || true

old=""
for f in commands/huginn.md commands/huginn-refine.md plugins/huginn.ts; do
  [ -f "$cfg/$f" ] && old="$old $f"
done
if [ -n "$old" ]; then
  bak="$cfg/huginn-old-backup-$(date +%Y%m%d-%H%M%S)"
  for f in $old; do mkdir -p "$bak/$(dirname "$f")"; mv "$cfg/$f" "$bak/$f"; done
  echo "moved the older integration to $bak:$old"
fi

major=$(opencode --version 2>/dev/null | sed -n 's/^[^0-9]*\([0-9]*\)\..*/\1/p' | head -1)
if [ "${major:-0}" -ge 2 ]; then
  # OpenCode 2.x: TUI plugins are listed in cli.json; a local plugin is a directory (opencode2/tui.tsx).
  python3 - "$cfg/cli.json" "$src/opencode2" <<'PY'
import json, sys
path, entry = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {"$schema": "https://opencode.ai/v2/cli.json"}
def name(p):
    return p.get("package", "") if isinstance(p, dict) else p
keep, opts = [], None
for p in cfg.get("plugins", []):
    if "huginn-voice" in name(p):
        if isinstance(p, dict) and p.get("options"):
            opts = p["options"]    # keep the options already set
        continue
    keep.append(p)
keep.append({"package": entry, "options": opts} if opts else entry)
cfg["plugins"] = keep
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f"{path}: huginn-voice -> {entry}")
PY
else
python3 - "$cfg/tui.json" "$src/opencode/huginn-voice.js" <<'PY'
import json, os, sys
path, entry = sys.argv[1], sys.argv[2]
try:
    with open(path) as f:
        cfg = json.load(f)
except FileNotFoundError:
    cfg = {"$schema": "https://opencode.ai/tui.json"}
def name(p):
    return p[0] if isinstance(p, list) else p
keep, opts = [], None
for p in cfg.get("plugin", []):
    n = name(p)
    if "huginn-voice" in n:
        if isinstance(p, list) and len(p) > 1:
            opts = p[1]            # keep the options already set
        continue
    keep.append(p)
keep.append([entry, opts] if opts else entry)
cfg["plugin"] = keep
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(f"{path}: huginn-voice -> {entry}")
PY
fi
[ -n "$HUGINN_API_KEY" ] || echo "note: HUGINN_API_KEY is not set in this shell; OpenCode needs it (or api_key in the plugin options)"
echo "restart OpenCode, then /huginn or alt+h"
