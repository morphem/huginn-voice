#!/bin/sh
# Install (or update) the OpenCode side of huginn-voice for this user.
#
#   sh scripts/install-opencode.sh          from a clone of github.com/morphem/huginn-voice
#
# OpenCode loads TUI plugins from ~/.config/opencode/tui.json. Its own installer
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
[ -n "$HUGINN_API_KEY" ] || echo "note: HUGINN_API_KEY is not set in this shell; OpenCode needs it (or api_key in tui.json)"
echo "restart OpenCode, then /huginn or alt+h"
