# huginn-voice — dictate into Claude Code with your own GPU

`/huginn` streams the microphone to the **Huginn ear** (`/api/ear`, `mode: "dictate"`). The ear runs
faster-whisper `large-v3` on Huginn's own GPU and sends back each phrase about one second after you
pause. Each phrase lands in the prompt box, where you can edit it. Nothing goes to Anthropic or to any
other cloud speech service, and this works with any model provider (for example GitHub Copilot).

```
/huginn     start listening (status line: ● Huginn listening)
…speak…     each phrase appears in the box after a short pause
Enter       send the prompt AND stop; the phrase still in flight is added to the prompt first
/huginn     (while listening) stop without sending; the last phrase lands in the box
```

Dictate mode creates **no note** in the mind, no job, and no model call except the decoder.

## Requirements

- `python3` and `ffmpeg` on the path (the client `bin/huginn-ear.py` is stdlib only).
- A PulseAudio source. Under WSL2 (WSLg) the Windows microphone is `RDPSource`, the plugin's default.
  List the sources with `ffmpeg -sources pulse`.
- A named Huginn user key.

## Install

From a clone or a local folder:

```
/plugin marketplace add /path/to/huginn-voice
/plugin install huginn-voice@huginn-voice
```

From GitHub:

```
/plugin marketplace add morphem/huginn-voice
/plugin install huginn-voice@huginn-voice
```

The install screen asks for the options below. For a one-off try without installing:

```
HUGINN_API_KEY=… claude --plugin-dir /path/to/huginn-voice
```

## Options

| Option | Default | Meaning |
|---|---|---|
| `api_key` | — | Huginn key (stored in secure storage). Empty: `HUGINN_API_KEY` from the environment |
| `url` | `https://huginn.prawdzik.eu` | the Huginn server |
| `mic` | `RDPSource` | pulse source (the Windows microphone under WSL2); `default` follows the system |
| `python` | `python3` | interpreter for the client |

## Test the engine without Claude Code

```
HUGINN_API_KEY=… python3 bin/huginn-ear.py                  # speak; Ctrl-C stops and flushes
HUGINN_API_KEY=… python3 bin/huginn-ear.py --input talk.webm  # stream a recording instead
```

Each output line is JSON: `pid`, `ready`, `heard` (with `decode_ms`), then `done` or `error`.

## Develop

```
claude plugin validate .
claude plugin test .          # tests/ear.test.ts fakes the client at process.spawn
```

## Known limits (v0.1)

- Text arrives per **phrase**, not word by word: the server sends a phrase after 300 ms of silence.
  Whisper sometimes ends a phrase with `...` where you only paused.
- Stop uses `kill -INT`, so the plugin needs a POSIX host (Linux, WSL, macOS).
