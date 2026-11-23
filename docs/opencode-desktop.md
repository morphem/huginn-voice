# OpenCode Desktop integration: notes, findings, and backlog

Written 2026-11-23. Versions at the time: OpenCode Desktop 2.3.0 on Windows, OpenCode CLI 2.3.0 in WSL
(Ubuntu), `@opencode/plugin` 2.2.7 for the build.

This file records how the `desktop/` plugin was made, what works, what did not work, and what is open.
Read it before you change `desktop/` or `scripts/install-desktop.sh`.

## 1. What the plugin does

- A **Huginn** pill above the prompt box of OpenCode Desktop (a `ComposerPill`).
- A click on the pill, **alt+h**, or `/huginn` starts dictation. The same action stops it.
- While you speak, the pill shows the phrase being spoken. At a pause, the phrase goes into the prompt box.
- When dictation stops, the final text from Huginn replaces the phrases in one step.
- Dictation never sends the prompt. The user sends it with the normal send button or Enter.
- Dictation continues when the OpenCode window is not active. The user can read another window and speak.
- A second dictation adds text after the text that is in the box.

## 2. How it works

```
OpenCode Desktop (Windows, Electron)
 ├─ window (setup)   pill, commands, writes into the composer
 │     composer.insert(phrase) · composer.setText(finals)
 └─ main process     Ipc "huginn-voice.ear" (state: off/connecting/listening/stopping, partial)
       │  spawn wsl.exe --exec bash -s   (script on stdin)
       ▼
WSL: python3 bin/huginn-ear.py  ──wss──▶  Huginn /api/dictate (GPU, large-v3)
       stdout: JSON lines pid / mic / ready / partial / phrase / final / done / error
       stop:   wsl.exe --exec kill -INT <pid>
```

Files:

| File | Role |
|---|---|
| `desktop/src/gui.tsx` | `Plugin.define({ os: ["windows"], setup, main })` |
| `desktop/src/main.ts` | Electron main process: runs the ear in WSL, holds the state, emits `phrase`, `final`, `done` |
| `desktop/src/window.tsx` | Window: the pill, the `dictate` command (alt+h, `/huginn`), composer writes |
| `desktop/src/contract.ts` | The `Ipc` contract between main and the windows |
| `desktop/src/text.ts` | Box arithmetic, the same as `opencode2/tui.tsx` (keep the two copies in step) |
| `desktop/test/text.test.ts` | Tests for the box arithmetic (`bun test`) |
| `scripts/install-desktop.sh` | Builds `desktop/` and installs it into the Windows config |

## 3. Facts that shaped the design

1. **OpenCode Desktop loads GUI plugins from its own Windows server.** That server reads only
   `%USERPROFILE%\.config\opencode\opencode.json`. The WSL config (`~/.config/opencode`) has no effect on GUI
   plugins. So the install script writes the Windows config, and it copies the bundle to
   `%USERPROFILE%\.local\share\huginn-voice-desktop`.
2. **The microphone stays in WSL.** WSLg gives the Windows microphone to WSL as the PulseAudio source
   `RDPSource`. The existing engine `bin/huginn-ear.py` already works there, so the main process only starts it
   with `wsl.exe`.
3. **`wsl.exe` does not read `~/.bashrc`.** The script reads the key from `~/.config/huginn-voice/env`
   (written by `scripts/install-hotkey.sh`) or from `~/.huginn-env`. Plugin options win over both.
4. **The script goes to `bash -s` on stdin.** OpenCode's own WSL server uses the same method. It avoids Windows
   command-line quoting.
5. **The composer API** (`ctx.screen.current()?.composer`) has `text()`, `insert()`, `setText()`, and `focus()`.
   It has **no submit method**.
6. **There is no slot next to the send button.** `ComposerPill` (the row above the prompt box) is the nearest
   place.

## 4. What did not work, and the fixes

| Problem | Cause | Fix |
|---|---|---|
| The script did not run with `wsl.exe --exec bash -c "<script>"` | Windows command-line quoting broke the script | Send the script on stdin to `bash -s` (`main.ts`) |
| Auto-send with Enter during dictation | The composer has no submit method. The first version focused the box and dispatched a synthetic Enter. The user does not want auto-send | Removed. Enter belongs to the app. Dictation never sends (commit `fe0fd86`) |
| A new bundle did not reload in the app | The Windows server stops its file watchers when it is idle. A copied bundle was not seen | The install script sends one API request (`opencode-cli.exe api get /api/plugin`) to wake the server before it copies the bundle (commit `945615a`) |
| `cmd.exe` was not found from the install script | `cmd.exe` is not always on the WSL `PATH`, and it warns when the current folder is a WSL path | Use `/mnt/c/Windows/System32/cmd.exe` as a fallback and run it from `/mnt/c` |
| MCP servers that start Windows programs failed in the shared OpenCode service (`exited with code 1`) | The service kept `WSL_INTEROP` from a WSL session that had closed | `opencode service restart`. Not a plugin problem, but the same mechanism (`wsl.exe` interop) applies |

## 5. Known limits

1. **Windows only** (`os: ["windows"]`). On Linux or macOS Desktop, the main process would run the ear
   directly, without `wsl.exe`. This is not built.
2. **The GUI plugin API is experimental** (`./gui-experimental`). Check the pill after each OpenCode update.
3. **One dictation at a time** for all windows. Other windows show "Huginn: busy in another window".
4. Stop uses `kill -INT` in WSL. If the PID line did not arrive yet, the main process kills `wsl.exe`
   and the last open chunk can be lost.
5. Options go in the plugin entry of the **Windows** config: `api_key`, `url`, `mic`, `save`, `python`, `ear`,
   `key`, `distro`.

## 6. Test record (2026-11-12)

- The Windows server loaded the plugin (`/api/plugin`: `huginn-voice`, `gui: true`, `active`).
- The pill appeared without an app restart.
- The ear started from Windows: `ready` with `large-v3` on `cuda`, then `mic`.
- The user dictated a long message: phrases appeared during the speech, the final text replaced them after stop,
  and a second dictation added text after the first. The prompt box scrolled and did not grow without limit.
- Dictation continued while the user worked in another window.

## 7. Backlog

Ideas from the user, 2026-11-23. Not started.

1. **Mode drop-down on the pill.** The pill opens a menu (`ComposerPill` `rows` or `menu`) with modes:
   - **Plain**: 1:1 transcription (now).
   - **Corrected Polish**: the final text goes through a correction step on the Huginn server.
   - **English**: Polish speech, English text. Huginn already has `POST /api/translate` (≥ 1.151.0), which
     the Windows hotkey uses with Right Shift.
   The selected mode stays as plugin state (`Store.global`).
2. **A color per mode.** `ComposerPill` has `tone` (`success`, `warning`, `danger`) and `icon`. More colors need
   `Style` with scoped CSS.
3. **Structure the prompt.** A second action that reads `composer.text()`, sends it to a Huginn endpoint (for
   example `POST /api/refine`) or to `session.generate`, and writes the result with `composer.setText()`.
   It never sends.
4. A settings page (`SettingsPage`) for the microphone, the mode, and the key, instead of config options.
5. Linux and macOS support for the main process (run the ear without `wsl.exe`).
