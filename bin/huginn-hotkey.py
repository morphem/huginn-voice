#!/usr/bin/env python3
"""Hold a key, speak, let go: one dictation for the Windows hotkey (windows/huginn-hotkey.ahk).

The AutoHotkey script runs this through wsl.exe when the key goes down and talks to it through
three files in one directory (a Windows temp folder, seen from WSL under /mnt/c):

    mic      we write it when the microphone is open — the tooltip turns into "listening"
    stop     AutoHotkey writes it when the key comes up — we stop and finalize
    out.txt  we write the final text, on ONE line, when we are done; AutoHotkey types it
    err.txt  we write why, when there is no text to give

The engine is bin/huginn-ear.py (the same socket, decoder and glossary as /huginn). The finals
replace the phrases they cover, as in the prompt box, so the text is what Huginn decoded the way it
decodes a recorded thought. Line breaks are never written: a newline typed into a chat box sends it.

The session recording goes to Huginn's 'prompts' space with source 'hotkey' (HUGINN_SOURCE), so it
stays out of the mind and apart from the prompts dictated into Claude Code.

The key and settings come from the environment or from ~/.config/huginn-voice/env (KEY=VALUE lines):
wsl.exe -e starts no login shell, so a key exported in ~/.bashrc is not seen here.
"""

import argparse
import json
import os
import signal
import subprocess
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(os.path.expanduser("~"), ".config", "huginn-voice", "env")
MAX_HOLD_S = 300          # a key that never comes up (AutoHotkey died) does not hold the mic forever
POLL_S = 0.05


def load_env(path: str = ENV_FILE) -> None:
    """KEY=VALUE lines into os.environ, without overriding what is already set."""
    try:
        with open(path, encoding="utf-8") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))
    except OSError:
        pass


def assemble(events) -> str:
    """The final text from the ear's events: each final takes the place of the phrases it lists."""
    parts = []                                    # [kind, id or None, text]
    for e in events:
        t = e.get("type")
        if t == "phrase":
            parts.append(["p", e.get("id"), e.get("text") or ""])
        elif t == "final":
            ids = set(e.get("ids") or [])
            at = next((i for i, p in enumerate(parts) if p[0] == "p" and p[1] in ids), len(parts))
            parts = [p for p in parts if not (p[0] == "p" and p[1] in ids)]
            parts.insert(min(at, len(parts)), ["f", None, e.get("text") or ""])
    text = " ".join(p[2].strip() for p in parts if p[2].strip())
    return " ".join(text.split())                 # one line: no newline may reach a chat box


def write(path: str, text: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dir", required=True, help="the exchange directory (see above)")
    ap.add_argument("--input", help="stream this audio file instead of the microphone (testing)")
    args = ap.parse_args(argv)

    load_env()
    os.environ.setdefault("HUGINN_SOURCE", "hotkey")
    os.environ.setdefault("HUGINN_MIC", "RDPSource")          # the Windows microphone under WSLg
    out, err, stop = (os.path.join(args.dir, n) for n in ("out.txt", "err.txt", "stop"))

    cmd = [sys.executable, os.path.join(HERE, "huginn-ear.py")]
    if args.input:
        cmd += ["--input", args.input]
    ear = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True)

    events, error = [], None
    started = time.monotonic()

    def read_events():
        nonlocal error
        for line in ear.stdout:
            try:
                e = json.loads(line)
            except ValueError:
                continue
            if e.get("type") == "mic":
                write(os.path.join(args.dir, "mic"), "")
            elif e.get("type") == "error":
                error = e.get("message") or "the ear failed"
            events.append(e)

    reader = threading.Thread(target=read_events, daemon=True)
    reader.start()

    while ear.poll() is None:
        if os.path.exists(stop) or time.monotonic() - started > MAX_HOLD_S:
            ear.send_signal(signal.SIGINT)                     # the ear finalizes what is open
            break
        time.sleep(POLL_S)
    try:
        ear.wait(timeout=30)
    except subprocess.TimeoutExpired:
        ear.kill()
    reader.join(timeout=2)

    text = assemble(events)
    if text:
        write(out, text)
        return 0
    write(err, error or "nothing was heard")
    return 1


if __name__ == "__main__":
    sys.exit(main())
