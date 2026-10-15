#!/usr/bin/env python3
"""Stream the microphone to Huginn's dictation socket and print what it hears, one JSON line each.

    ffmpeg (pulse, 16 kHz mono s16le)  →  wss://<huginn>/api/dictate
                                       ←  partial / phrase / final events  →  stdout

Huginn decodes on its own GPU while you speak. It creates no note and no job and calls no model
except the decoder. Stdout carries only JSON lines, so a caller can parse every line:

    {"type": "pid", "pid": 1234}                      first, so the caller can stop us with SIGINT
    {"type": "ready", "model", "device", ...}         the server loaded the decoder; speak now
    {"type": "partial", "text"}                       preview of the phrase being spoken (not kept)
    {"type": "phrase", "id", "chunk", "text"}         a phrase ended: this text goes in the box
    {"type": "final", "chunk", "ids", "text"}         ~20 s of audio decoded like a recorded thought:
                                                      replaces the phrases listed in "ids"
    {"type": "error", "message"}                      then exit 1
    {"type": "done"}                                  then exit 0

SIGINT or SIGTERM stops the recording cleanly: the microphone stops, the script asks the server to
finalize what is still open (the last phrase and the last chunk), prints it, and exits.
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

SAMPLE_RATE = 16000
CHUNK_BYTES = SAMPLE_RATE * 2 // 10      # 100 ms of int16 mono
FINALIZE_WAIT_S = 15.0                   # the open chunk (<30 s of audio) decodes in ~1-3 s on the GPU
CONNECT_TIMEOUT_S = 10
READY_TIMEOUT_S = 60                     # the first connection after a restart loads the model


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

def ffmpeg_cmd(device: str, input_file: str = None) -> list:
    """The microphone, or (`input_file`, for tests) a recording played at real-time speed."""
    src = ["-re", "-i", input_file] if input_file else ["-f", "pulse", "-i", device]
    return ["ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", *src,
            "-ac", "1", "-ar", str(SAMPLE_RATE), "-f", "s16le", "-"]


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--url", default=os.environ.get("HUGINN_URL") or "https://huginn.prawdzik.eu")
    ap.add_argument("--device", default=os.environ.get("HUGINN_MIC") or "default",
                    help="pulse source; under WSL2 the Windows microphone is RDPSource")
    ap.add_argument("--input", help="stream this audio file instead of the microphone (testing)")
    args = ap.parse_args(argv)

    emit({"type": "pid", "pid": os.getpid()})
    key = api_key(os.environ.get("HUGINN_API_KEY", ""))
    if not key:
        emit({"type": "error", "message": "HUGINN_API_KEY is not set"})
        return 1

    stopping = threading.Event()
    signal.signal(signal.SIGINT, lambda *_: stopping.set())
    signal.signal(signal.SIGTERM, lambda *_: stopping.set())

    try:
        ws = WebSocket(args.url)
        ws.send(json.dumps({"type": "hello", "key": key}))
    except Exception as exc:
        emit({"type": "error", "message": f"cannot reach the ear at {args.url}: {exc}"})
        return 1

    ready = threading.Event()
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
                    ready.set()
                    emit({"type": "ready", "model": d.get("model"), "device": d.get("device")})
                elif d.get("type") in ("partial", "phrase", "final"):
                    if (d.get("text") or "").strip():
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
        emit({"type": "error", "message": failed[0] if failed else "the ear did not become ready"})
        ws.close()
        return 1

    try:
        mic = subprocess.Popen(ffmpeg_cmd(args.device, args.input), stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    except FileNotFoundError:
        emit({"type": "error", "message": "ffmpeg is not installed"})
        ws.close()
        return 1

    def pump():
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
            try:
                ws.send(chunk)
            except OSError as exc:
                failed.append(f"connection lost: {exc}")
                stopping.set()
                return

    threading.Thread(target=pump, daemon=True).start()
    while not stopping.wait(0.2):
        pass

    mic.terminate()
    try:
        mic.wait(timeout=2)
    except subprocess.TimeoutExpired:
        mic.kill()

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
        return 1
    emit({"type": "done"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
