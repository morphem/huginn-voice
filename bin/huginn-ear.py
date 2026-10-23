#!/usr/bin/env python3
"""Stream the microphone to Huginn's dictation socket and print what it hears, one JSON line each.

    ffmpeg (pulse, 16 kHz mono s16le)  →  wss://<huginn>/api/dictate
                                       ←  partial / phrase / final events  →  stdout

Huginn decodes on its own GPU while you speak. It creates no note and no job and calls no model
except the decoder. Stdout carries only JSON lines, so a caller can parse every line:

    {"type": "pid", "pid": 1234}                      first, so the caller can stop us with SIGINT
    {"type": "mic"}                                   the microphone is open; speak now (audio said
                                                      before the server is ready is held and sent)
    {"type": "ready", "model", "device", ...}         the server loaded the decoder
    {"type": "partial", "text"}                       preview of the phrase being spoken (not kept)
    {"type": "phrase", "id", "chunk", "text"}         a phrase ended: this text goes in the box
    {"type": "final", "chunk", "ids", "text"}         ~20 s of audio decoded like a recorded thought:
                                                      replaces the phrases listed in "ids"
    {"type": "error", "message"}                      then exit 1
    {"type": "done"}                                  then exit 0

SIGINT or SIGTERM stops the recording cleanly: the microphone stops, the script asks the server to
finalize what is still open (the last phrase and the last chunk), prints it, and exits.

The microphone opens FIRST, while the connection is still being made: opening it takes ~0.7 s and
the server another ~0.2 s, and words said in that time used to be lost. They are held in memory and
sent once the server says ready.

Unless HUGINN_SAVE is "off", ffmpeg also writes the whole session as ONE continuous recording (Opus,
real pauses kept). After "done", a detached process (`--upload FILE`) sends it to POST
/api/transcribe with scope=prompts: Huginn transcribes it the way it transcribes any thought and
files it in the 'prompts' space, which the cosmos hides by default. This process does not wait for
it, so the prompt is never delayed. A file that fails to upload stays in ~/.cache/huginn-voice/.
Stdlib only, so the file runs anywhere that has python3 and ffmpeg.
"""

import argparse
import base64
import json
import os
import signal
import socket
import ssl
import struct
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
import uuid

SAMPLE_RATE = 16000
CHUNK_BYTES = SAMPLE_RATE * 2 // 10      # 100 ms of int16 mono
FINALIZE_WAIT_S = 15.0                   # the open chunk (<30 s of audio) decodes in ~1-3 s on the GPU
CONNECT_TIMEOUT_S = 10
READY_TIMEOUT_S = 60                     # the first connection after a restart loads the model
SAVE_BITRATE = "128k"                    # VBR, as huginn.voice: silence collapses, so the server's
                                         # silent-capture gate (60 kbps) still sees a dead microphone
MIN_SAVE_S = 2.0                         # a session shorter than this is not worth a thought
CACHE_DIR = os.path.join(os.path.expanduser("~"), ".cache", "huginn-voice")


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def api_key(raw: str) -> str:
    """Accept a single key or the server's roster shape `name:key,name:key` (send the first key)."""
    raw = (raw or "").strip()
    if not raw:
        return ""
    first = raw.split(",")[0].strip()
    return first.split(":", 1)[1].strip() if ":" in first else first


# --- a minimal RFC 6455 client --------------------------------------------------------------------

class WebSocket:
    def __init__(self, url: str):
        u = urllib.parse.urlparse(url)
        secure = u.scheme in ("https", "wss")
        host = u.hostname
        port = u.port or (443 if secure else 80)
        raw = socket.create_connection((host, port), timeout=CONNECT_TIMEOUT_S)
        self.sock = ssl.create_default_context().wrap_socket(raw, server_hostname=host) if secure else raw
        key = base64.b64encode(os.urandom(16)).decode()
        path = (u.path.rstrip("/") or "") + "/api/dictate"
        req = (
            f"GET {path} HTTP/1.1\r\nHost: {host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n"
            f"User-Agent: Huginn-Ear-CLI/0.1\r\n\r\n"
        )
        self.sock.sendall(req.encode())
        head = b""
        while b"\r\n\r\n" not in head:
            part = self.sock.recv(4096)
            if not part:
                raise ConnectionError("the server closed the connection during the handshake")
            head += part
        status = head.split(b"\r\n", 1)[0].decode(errors="replace")
        if " 101 " not in status + " ":
            raise ConnectionError(f"the server refused the WebSocket upgrade: {status}")
        self._pending = head.split(b"\r\n\r\n", 1)[1]
        self.sock.settimeout(None)
        self._lock = threading.Lock()
        self.close_code = None

    def send(self, payload, opcode: int = None) -> None:
        if isinstance(payload, str):
            payload, opcode = payload.encode(), opcode or 0x1
        opcode = opcode or 0x2
        n = len(payload)
        if n < 126:
            head = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            head = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            head = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        mask = os.urandom(4)
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(payload)) if n < 512 else _mask(payload, mask)
        with self._lock:
            self.sock.sendall(head + mask + body)

    def _read(self, n: int) -> bytes:
        out = b""
        if self._pending:
            out, self._pending = self._pending[:n], self._pending[n:]
        while len(out) < n:
            part = self.sock.recv(n - len(out))
            if not part:
                raise ConnectionError("connection closed")
            out += part
        return out

    def recv(self):
        """The next text or binary message, or None once the server closed the connection."""
        data, kind = b"", None
        while True:
            b1, b2 = self._read(2)
            fin, opcode, n = b1 & 0x80, b1 & 0x0F, b2 & 0x7F
            if n == 126:
                n = struct.unpack("!H", self._read(2))[0]
            elif n == 127:
                n = struct.unpack("!Q", self._read(8))[0]
            payload = self._read(n)
            if opcode == 0x8:
                self.close_code = struct.unpack("!H", payload[:2])[0] if len(payload) >= 2 else 1005
                return None
            if opcode == 0x9:
                self.send(payload, 0xA)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                kind = opcode
            data += payload
            if fin:
                return data.decode() if kind == 0x1 else data

    def close(self) -> None:
        try:
            self.send(struct.pack("!H", 1000), 0x8)
        except OSError:
            pass
        try:
            self.sock.close()
        except OSError:
            pass


def _mask(payload: bytes, mask: bytes) -> bytes:
    n = len(payload)
    m = (mask * (n // 4 + 1))[:n]
    return (int.from_bytes(payload, "big") ^ int.from_bytes(m, "big")).to_bytes(n, "big")


# --- the session ----------------------------------------------------------------------------------

def ffmpeg_cmd(device: str, input_file: str = None, save_path: str = None) -> list:
    """The microphone, or (`input_file`, for tests) a recording played at real-time speed. PCM for
    the socket on stdout; with `save_path`, the same audio also as one Opus file."""
    src = ["-re", "-i", input_file] if input_file else ["-f", "pulse", "-i", device]
    cmd = ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", *src,
           "-map", "0:a", "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"]
    if save_path:
        cmd += ["-map", "0:a", "-ac", "1", "-c:a", "libopus", "-b:a", SAVE_BITRATE, "-y", save_path]
    return cmd


# --- the recording, kept as a thought -----------------------------------------------------------

def upload(path: str, url: str, key: str, device: str) -> int:
    """Send one saved session to Huginn as a thought in the 'prompts' space. Deletes the file once
    the server has it; keeps it (and says why in upload.log) when it does not."""
    boundary = "----huginn" + uuid.uuid4().hex
    with open(path, "rb") as f:
        audio = f.read()
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{os.path.basename(path)}\"\r\n"
            f"Content-Type: audio/webm\r\n\r\n").encode() + audio + f"\r\n--{boundary}--\r\n".encode()
    q = urllib.parse.urlencode({"source": os.environ.get("HUGINN_SOURCE") or "claude-code",
                               "scope": "prompts", "device_label": device})
    req = urllib.request.Request(
        url.rstrip("/") + "/api/transcribe?" + q, data=body, method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "X-API-Key": key,
                 "Idempotency-Key": os.path.basename(path), "User-Agent": "Huginn-Ear-CLI/0.1"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            ok = r.status in (200, 202)
            why = f"HTTP {r.status}"
    except Exception as exc:
        ok, why = False, str(exc)
    if ok:
        os.remove(path)
        return 0
    try:
        with open(os.path.join(CACHE_DIR, "upload.log"), "a", encoding="utf-8") as log:
            log.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {os.path.basename(path)} not sent: {why}\n")
    except OSError:
        pass
    return 1


def upload_later(path: str) -> None:
    """Hand the file to a detached copy of this script, so the caller is not kept waiting."""
    try:
        subprocess.Popen([sys.executable, os.path.abspath(__file__), "--upload", path],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                         start_new_session=True, env=os.environ.copy())
    except OSError:
        pass   # the file stays in the cache


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--url", default=os.environ.get("HUGINN_URL") or "https://huginn.prawdzik.eu")
    ap.add_argument("--device", default=os.environ.get("HUGINN_MIC") or "default",
                    help="pulse source; under WSL2 the Windows microphone is RDPSource")
    ap.add_argument("--input", help="stream this audio file instead of the microphone (testing)")
    ap.add_argument("--upload", metavar="FILE", help="send a saved session to Huginn and exit (internal)")
    args = ap.parse_args(argv)
    key = api_key(os.environ.get("HUGINN_API_KEY", ""))
    if args.upload:
        return upload(args.upload, args.url, key, args.device)

    emit({"type": "pid", "pid": os.getpid()})
    os.environ["HUGINN_URL"], os.environ["HUGINN_MIC"] = args.url, args.device   # the uploader reads these
    if not key:
        emit({"type": "error", "message": "HUGINN_API_KEY is not set"})
        return 1

    stopping = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())

    save_path = None
    if (os.environ.get("HUGINN_SAVE") or "on").strip().lower() not in ("off", "0", "no", "false"):
        try:
            os.makedirs(CACHE_DIR, exist_ok=True)
            save_path = os.path.join(CACHE_DIR, f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}.webm")
        except OSError:
            save_path = None

    # The microphone first: it takes ~0.7 s to open, and the server answers while it does.
    try:
        mic = subprocess.Popen(ffmpeg_cmd(args.device, args.input, save_path),
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        emit({"type": "error", "message": "ffmpeg is not installed"})
        return 1
    started = time.monotonic()

    def stop_mic():
        if mic.poll() is None:
            mic.send_signal(signal.SIGINT)     # SIGINT, so ffmpeg writes the end of the saved file
        try:
            mic.wait(timeout=3)
        except subprocess.TimeoutExpired:
            mic.kill()

    ws_box = []
    held = []                                  # audio read before the server was ready
    heard = threading.Event()                  # the server sent back at least one word
    failed = []
    ready = threading.Event()
    lock = threading.Lock()

    def pump():
        first = True
        while not stopping.is_set():
            chunk = mic.stdout.read(CHUNK_BYTES)
            if not chunk:
                if args.input:
                    stopping.set()             # the file ended: flush and finish like a stop
                    return
                if not stopping.is_set():
                    err = (mic.stderr.read() or b"").decode(errors="replace").strip()
                    failed.append(f"the microphone stopped: {err or 'ffmpeg exited'}")
                    stopping.set()
                return
            if first:
                first = False
                emit({"type": "mic"})
            with lock:
                if not ready.is_set() or failed:
                    held.append(chunk)
                    continue
            try:
                ws_box[0].send(chunk)
            except OSError as exc:
                failed.append(f"connection lost: {exc}")
                stopping.set()
                return

    threading.Thread(target=pump, daemon=True).start()

    def give_up(message):
        stop_mic()
        emit({"type": "error", "message": message})
        keep(save_path, started, heard, failed=True)
        return 1

    try:
        ws = WebSocket(args.url)
        ws.send(json.dumps({"type": "hello", "key": key}))
    except Exception as exc:
        return give_up(f"cannot reach the ear at {args.url}: {exc}")
    ws_box.append(ws)

    finalized = threading.Event()
    failed = []

    def reader():
        try:
            while True:
                msg = ws.recv()
                if msg is None:
                    if not stopping.is_set():
                        why = {4401: "the API key was refused", 4400: "the server refused the hello"}
                        failed.append(why.get(ws.close_code, f"the ear closed the connection ({ws.close_code})"))
                    break
                if not isinstance(msg, str):
                    continue
                d = json.loads(msg)
                if d.get("type") == "ready":
                    with lock:                 # what was said while connecting goes first
                        for chunk in held:
                            ws.send(chunk)
                        held.clear()
                        ready.set()
                    emit({"type": "ready", "model": d.get("model"), "device": d.get("device")})
                elif d.get("type") in ("partial", "phrase", "final"):
                    if (d.get("text") or "").strip():
                        heard.set()
                        emit({k: d[k] for k in ("type", "id", "chunk", "ids", "text", "decode_ms") if k in d})
                elif d.get("type") == "finalized":
                    finalized.set()
                elif d.get("type") == "error":
                    failed.append(d.get("message") or "the ear reported an error")
        except Exception as exc:
            if not stopping.is_set():
                failed.append(f"connection lost: {exc}")
        finally:
            ready.set()
            stopping.set()

    threading.Thread(target=reader, daemon=True).start()
    if not ready.wait(READY_TIMEOUT_S) or failed:
        ws.close()
        return give_up(failed[0] if failed else "the ear did not become ready")

    while not stopping.wait(0.2):
        pass
    stop_mic()

    if not failed:
        # Ask the server to decode what is still open; wait for it to say it is done.
        try:
            ws.send(json.dumps({"type": "finalize"}))
            finalized.wait(FINALIZE_WAIT_S)
        except OSError:
            pass

    ws.close()
    if failed:
        emit({"type": "error", "message": failed[0]})
        keep(save_path, started, heard, failed=True)
        return 1
    emit({"type": "done"})
    keep(save_path, started, heard, failed=False)
    return 0


def keep(path, started, heard, failed: bool) -> None:
    """Send the saved session on, or drop it. A session in which the server heard words is a prompt.
    One that failed is sent too, if it is long enough to hold speech: the recording is then the only
    copy of what was said. A short session with nothing heard (/huginn pressed twice) is dropped."""
    if not path or not os.path.exists(path):
        return
    long_enough = time.monotonic() - started >= MIN_SAVE_S
    if heard.is_set() or (failed and long_enough):
        upload_later(path)
    else:
        try:
            os.remove(path)
        except OSError:
            pass


if __name__ == "__main__":
    sys.exit(main())
