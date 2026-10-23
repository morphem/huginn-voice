#!/usr/bin/env python3
"""Hold a key, speak, let go: one dictation for the Windows hotkey (windows/huginn-hotkey.ahk).

The AutoHotkey script starts this through wsl.exe once (--serve) and talks to it through files in
one directory (a Windows temp folder, seen from WSL under /mnt/c):

    go       AutoHotkey writes it when the key goes down — we start (--serve waits warm for it)
    mic      we write it when the microphone is open — the tooltip turns into "speak"
    stop     AutoHotkey writes it when the key comes up — we stop and finalize; "en" inside it
             (Right Shift was held) asks Huginn for English (POST /api/translate)
    out.txt  we write the final text, on ONE line; AutoHotkey types it
    src.txt  for English: the Polish that was heard, so the tooltip can show it
    err.txt  we write why, when there is no text to give
    done     we write it last, when out.txt or err.txt is in place

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
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ENV_FILE = os.path.join(os.path.expanduser("~"), ".config", "huginn-voice", "env")
MAX_HOLD_S = 300          # a key that never comes up (AutoHotkey died) does not hold the mic forever
POLL_S = 0.05
STALE_S = 600         # no `alive` touch for this long: the AutoHotkey script is gone


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


def to_english(text: str) -> str:
    """Huginn's translate endpoint; raises with a short reason when it cannot answer."""
    raw = (os.environ.get("HUGINN_API_KEY") or "").strip().split(",")[0].strip()
    key = raw.split(":", 1)[1].strip() if ":" in raw else raw        # a roster, as huginn-ear.api_key
    url = (os.environ.get("HUGINN_URL") or "https://huginn.prawdzik.eu").rstrip("/") + "/api/translate"
    req = urllib.request.Request(url, data=json.dumps({"text": text, "to": "en"}).encode(), method="POST",
                                 headers={"Content-Type": "application/json", "User-Agent": "Huginn-Hotkey/0.7",
                                          "X-API-Key": key})
    try:
        with urllib.request.urlopen(req, timeout=40) as r:
            return " ".join((json.loads(r.read()).get("text") or "").split())
    except urllib.error.HTTPError as exc:
        try:
            why = json.loads(exc.read()).get("detail")
        except ValueError:
            why = None
        raise RuntimeError(why or f"HTTP {exc.code}") from exc


def write(path: str, text: str) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


def dictate(d: str, input_file: str = None) -> int:
    """One dictation: from now until the stop file appears. Writes out.txt or err.txt, then done."""
    out, err, stop = (os.path.join(d, n) for n in ("out.txt", "err.txt", "stop"))
    cmd = [sys.executable, os.path.join(HERE, "huginn-ear.py")]
    if input_file:
        cmd += ["--input", input_file]
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
                write(os.path.join(d, "mic"), "")
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
    english = False
    try:
        with open(stop, encoding="utf-8") as f:
            english = f.read().strip() == "en"
    except OSError:
        pass
    if text and english:
        write(os.path.join(d, "src.txt"), text)
        try:
            text = to_english(text) or text
        except Exception as exc:                    # the Polish is still typed: nothing said is lost
            write(os.path.join(d, "src.txt"), f"not translated ({exc}) — typed in Polish")
    if text:
        write(out, text)
    else:
        write(err, error or "nothing was heard")
    write(os.path.join(d, "done"), "")
    return 0 if text else 1


def serve(d: str, input_file: str = None) -> int:
    """Wait warm for the `go` file, so a key press does not pay for starting WSL and Python (~1-2 s
    on a laptop, words said meanwhile were lost). The microphone stays CLOSED while waiting. Ends on
    the `quit` file, or when the script has not touched `alive` for STALE_S (AutoHotkey died)."""
    go, quit_, alive = (os.path.join(d, n) for n in ("go", "quit", "alive"))
    write(os.path.join(d, "waiting"), str(os.getpid()))
    while not os.path.exists(quit_):
        if os.path.exists(go):
            os.remove(go)
            dictate(d, input_file)
            continue
        try:
            if time.time() - os.path.getmtime(alive) > STALE_S:
                return 0
        except OSError:
            pass
        time.sleep(POLL_S)
    return 0


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--dir", required=True, help="the exchange directory (see above)")
    ap.add_argument("--serve", action="store_true", help="wait warm for `go` files (the hotkey's mode)")
    ap.add_argument("--input", help="stream this audio file instead of the microphone (testing)")
    args = ap.parse_args(argv)

    load_env()
    os.environ.setdefault("HUGINN_SOURCE", "hotkey")
    os.environ.setdefault("HUGINN_MIC", "RDPSource")          # the Windows microphone under WSLg
    return serve(args.dir, args.input) if args.serve else dictate(args.dir, args.input)


if __name__ == "__main__":
    sys.exit(main())
