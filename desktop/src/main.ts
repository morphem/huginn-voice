import { spawn, type ChildProcess } from "node:child_process"
import type { Plugin } from "@opencode/plugin/gui"
import { Ear, type EarState } from "./contract"
import { shellQuote } from "./text"

const STOP_WAIT_MS = 15000
const DEFAULT_MIC = "RDPSource"
const DEFAULT_EAR = "$HOME/.local/share/huginn-voice/bin/huginn-ear.py"

type Line =
  | { type: "pid"; pid: number }
  | { type: "mic" }
  | { type: "ready" }
  | { type: "partial"; text: string }
  | { type: "phrase"; id: number; chunk: number; text: string }
  | { type: "final"; chunk: number; ids: number[]; text: string }
  | { type: "error"; message: string }
  | { type: "done" }

type Run = {
  child: ChildProcess
  pid?: number
  failure: string
  ended: Promise<void>
}

/**
 * Runs the dictation client in WSL. `wsl.exe` starts a non-login shell, which does not read `~/.bashrc`, so the
 * script reads the key from `~/.config/huginn-voice/env` (written by scripts/install-hotkey.sh) or `~/.huginn-env`.
 * Plugin options win over both.
 */
export const main: Plugin.MainSetup = (ctx) => {
  const options = (ctx.options ?? {}) as Record<string, unknown>
  const opt = (key: string) => (typeof options[key] === "string" ? (options[key] as string).trim() : "")
  const distro = opt("distro")

  let state: EarState = { state: "off", partial: "", owner: -1 }
  let run: Run | undefined

  const set = (patch: Partial<EarState>) => {
    state = { ...state, ...patch }
    provider.changed()
  }

  const wsl = (args: string[]) => spawn("wsl.exe", [...(distro ? ["-d", distro] : []), ...args], { windowsHide: true })

  const script = () => {
    const exports: Record<string, string> = {}

    if (opt("api_key")) exports.HUGINN_API_KEY = opt("api_key")
    if (opt("url")) exports.HUGINN_URL = opt("url")
    if (opt("save")) exports.HUGINN_SAVE = opt("save")

    return [
      "set -a",
      '[ -f "$HOME/.config/huginn-voice/env" ] && . "$HOME/.config/huginn-voice/env"',
      '[ -f "$HOME/.huginn-env" ] && . "$HOME/.huginn-env"',
      "set +a",
      `export HUGINN_MIC=${shellQuote(opt("mic") || DEFAULT_MIC)}`,
      ...Object.entries(exports).map(([key, value]) => `export ${key}=${shellQuote(value)}`),
      `exec ${opt("python") ? shellQuote(opt("python")) : "python3"} ${opt("ear") ? shellQuote(opt("ear")) : `"${DEFAULT_EAR}"`}`,
    ].join("\n")
  }

  const onLine = (current: Run, raw: string) => {
    let line: Line

    try {
      line = JSON.parse(raw) as Line
    } catch {
      return
    }

    if (line.type === "pid") current.pid = line.pid
    else if (line.type === "mic" || line.type === "ready") {
      if (state.state === "connecting") set({ state: "listening" })
    } else if (line.type === "error") current.failure = line.message
    else if (line.type === "partial") {
      if (state.state === "listening") set({ partial: line.text })
    } else if (line.type === "phrase" && line.text) {
      set({ partial: "" })
      provider.emit("phrase", { id: line.id, text: line.text }, state.owner)
    } else if (line.type === "final" && line.text) {
      provider.emit("final", { ids: line.ids, text: line.text }, state.owner)
    }
  }

  const start = (window: number) => {
    if (run) throw new Error("Huginn is already listening")

    // The script goes in on stdin, as OpenCode's own WSL server does: no Windows command-line quoting.
    const child = wsl(["--exec", "bash", "-s"])
    child.stdin!.end(script() + "\n")
    let resolveEnded = () => {}
    const current: Run = { child, failure: "", ended: new Promise<void>((resolve) => (resolveEnded = resolve)) }
    let buffered = ""
    let errors = ""

    run = current
    set({ state: "connecting", partial: "", owner: window })

    child.stdout!.setEncoding("utf8")
    child.stdout!.on("data", (chunk: string) => {
      buffered += chunk
      let nl = buffered.indexOf("\n")

      while (nl >= 0) {
        const raw = buffered.slice(0, nl).trim()
        buffered = buffered.slice(nl + 1)
        nl = buffered.indexOf("\n")
        if (raw) onLine(current, raw)
      }
    })
    child.stderr!.setEncoding("utf8")
    child.stderr!.on("data", (chunk: string) => {
      errors = (errors + chunk).slice(-2000)
    })
    child.on("error", (error) => {
      current.failure ||= `could not start wsl.exe: ${String(error)}`
    })
    child.on("close", (code) => {
      if (!current.failure && code) current.failure = errors.trim().split("\n").pop() || `the client exited with ${code}`
      if (current.failure) ctx.log.write("warn", "huginn: dictation failed", { failure: current.failure })
      provider.emit("done", { failure: current.failure }, state.owner)
      if (run === current) run = undefined
      set({ state: "off", partial: "", owner: -1 })
      resolveEnded()
    })
  }

  /** SIGINT makes the client finalize what is still open, print it, and exit. */
  const stop = async () => {
    const current = run

    if (!current) return
    set({ state: "stopping", partial: "" })

    if (current.pid) wsl(["--exec", "kill", "-INT", String(current.pid)])
    else current.child.kill()

    const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), STOP_WAIT_MS))

    if ((await Promise.race([current.ended, timeout])) === "timeout") current.child.kill()
  }

  const provider = ctx.provide(Ear, {
    state: () => state,
    start: (_input, caller) => start(caller.window),
    stop: () => stop(),
  })

  ctx.onCleanup(() => {
    const current = run

    if (current?.pid) wsl(["--exec", "kill", "-INT", String(current.pid)])
    current?.child.kill()
  })
}
