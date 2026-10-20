# huginn-voice — dictate into Claude Code with your own GPU

`/huginn` streams the microphone to your own Huginn server (`/api/dictate`, Huginn ≥ 1.147.0), which
transcribes on its own GPU with faster-whisper `large-v3`. Nothing goes to Anthropic or to any other
cloud speech service, and this works with any model provider (for example GitHub Copilot).

```
/huginn         start listening (the band above the prompt: ● Huginn listening … [ Stop ])
…speak…         what you are saying shows in the box in grey; at a short pause it turns into
                the decoded phrase in plain text
Enter           the final text replaces the phrases, then the prompt is sent and listening stops
[ Stop ]        the same without sending: click it, or ctrl+x tab, then Enter (or s)
```

Two passes over the same audio:

- **While you talk:** a grey preview, then phrases (beam 5, the glossary, the text said before) land
  in the box. The band above the prompt stays one line, so the conversation does not jump.
- **In the background:** about every 12 s of audio is decoded again the way Huginn decodes a recorded
  thought (the capture beam, the glossary, the same decode settings). On stop or Enter only the last
  chunk is still open, so the final text arrives about 1.5 s after you stop, and replaces the phrases
  in one step.

If you edit a dictated phrase by hand before stop, the final for that part is dropped and your edit
stays.

The microphone opens first, while the client connects, and the band says *listening* as soon as it
is open: what you say before the server is ready is held and sent, so the first words are not lost.

**Saved as a thought (option `save`, on by default).** The client also records the whole session as
one continuous file, with your real pauses. After stop it hands the file to a detached upload, so
nothing waits for it: Huginn transcribes it the way it transcribes any thought and files it in the
**`prompts`** space, which the cosmos hides by default (switch to it with the *Prompts* chip). A
session in which nothing was heard is not sent. A file that fails to upload stays in
`~/.cache/huginn-voice/` (the reason is in `upload.log` there). Set `save` to `off` to keep nothing.
The live streaming itself still creates no note and no job.

Stopping never needs the prompt box: once the box holds dictated text, a typed `/huginn` would become
part of that text. Escape cannot stop listening: over text in the box it belongs to Claude Code, and
a plugin does not receive it.

Versions: `v0.2.1` (tag) is the phrase-only version on the older `/api/ear`. It is the fallback if the
streaming version misbehaves.

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
| `save` | `on` | `off`: do not keep the recording as a thought in the `prompts` space |

## Test the engine without Claude Code

```
HUGINN_API_KEY=… python3 bin/huginn-ear.py                  # speak; Ctrl-C stops and flushes
HUGINN_API_KEY=… python3 bin/huginn-ear.py --input talk.webm  # stream a recording instead
```

Each output line is JSON: `pid`, `mic`, `ready`, then `partial` / `phrase` / `final`, then `done` or
`error`. `HUGINN_SAVE=off` keeps the test session from being sent as a thought.

## Develop

```
claude plugin validate .
claude plugin test .          # tests/ear.test.ts fakes the client at process.spawn
```

## Known limits

- The live text arrives per **phrase** (after 300 ms of silence), not word by word; the grey preview
  in the box covers the phrase you are saying. The final text replaces it on stop.
- A spoken stop word is built but OFF (`VOICE_STOP` in `hooks/register.tsx`): in a test „koniec”
  stopped and „stop” did not, likely because the ear drops speech under 400 ms before decoding.
- Stop uses `kill -INT`, so the plugin needs a POSIX host (Linux, WSL, macOS).
