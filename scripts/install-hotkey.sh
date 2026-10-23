#!/bin/sh
# Install the Windows hotkey (hold Right Ctrl, speak, let go) from this clone. Run it inside WSL.
#   1. keeps the Huginn key in ~/.config/huginn-voice/env (wsl.exe -e does not read ~/.bashrc)
#   2. writes huginn-hotkey.ahk into your Windows home folder, pointing at this clone
#   3. with --autostart, also into the Windows Startup folder, so it runs after every sign-in
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
command -v ffmpeg >/dev/null || { echo "ffmpeg is missing: sudo apt install ffmpeg" >&2; exit 1; }
command -v wslpath >/dev/null || { echo "run this inside WSL" >&2; exit 1; }

conf="$HOME/.config/huginn-voice"; mkdir -p "$conf"
if ! grep -q '^HUGINN_API_KEY=' "$conf/env" 2>/dev/null; then
    key="${HUGINN_API_KEY:-}"
    if [ -z "$key" ]; then
        printf 'Huginn API key: ' >&2; stty -echo; read -r key; stty echo; echo >&2
    fi
    case "$key" in *:*) key=$(printf '%s' "$key" | cut -d, -f1 | cut -d: -f2-);; esac   # a roster
    [ -n "$key" ] || { echo "no key given" >&2; exit 1; }
    umask 077; printf 'HUGINN_API_KEY=%s\n' "$key" >> "$conf/env"
    echo "key saved in $conf/env"
fi

win_home=$(wslpath "$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\r')")
sed "s|{{WRAPPER}}|$here/bin/huginn-hotkey.py|" "$here/windows/huginn-hotkey.ahk" > "$win_home/huginn-hotkey.ahk"
echo "written: $(wslpath -w "$win_home/huginn-hotkey.ahk")"
if [ "${1:-}" = "--autostart" ]; then
    startup="$win_home/AppData/Roaming/Microsoft/Windows/Start Menu/Programs/Startup"
    cp "$win_home/huginn-hotkey.ahk" "$startup/"
    echo "and into Startup: it runs after every sign-in"
fi
echo "Double-click huginn-hotkey.ahk (a green H appears by the clock), then hold Right Ctrl and speak."
