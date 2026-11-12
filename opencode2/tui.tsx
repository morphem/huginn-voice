/** @jsxImportSource @opentui/solid */
/**
 * `/huginn` for OpenCode 2.x — the port of `opencode/huginn-voice.tsx` (OpenCode 1.x) to the V2 TUI
 * plugin API (`@opencode/plugin/tui`). Same engine (`bin/huginn-ear.py`), same server, same keys.
 *
 *   /huginn or alt+h   start listening
 *   …speak…            the partial phrase shows under the box; at a pause the phrase is appended
 *   Enter              finalizes, swaps in every final at once, sends, and stops
 *   alt+h              the same without sending
 *
 * How it reaches the box: V2 has no Prompt component or prompt slot for plugins. The prompt is the
 * focused OpenTUI textarea, so the plugin takes `renderer.currentFocusedRenderable` when dictation
 * starts and reads and writes its text (`plainText`, `replaceText`). It sends with the host's own
 * `prompt.submit` command. While listening, a keymap layer with a high priority owns Enter.
 *
 * Options (the object form of the entry in cli.json, or the environment): api_key / HUGINN_API_KEY,
 * url / HUGINN_URL, mic / HUGINN_MIC, python, save / HUGINN_SAVE, key (default alt+h).
 */
import { spawn, type ChildProcess } from "child_process"
import { dirname, join as joinPath } from "path"
import { fileURLToPath } from "url"
import { createSignal } from "solid-js"
import { Plugin } from "@opencode/plugin/tui"

const STOP_WAIT_MS = 15000
const DEFAULT_URL = "https://huginn.prawdzik.eu"
const DEFAULT_MIC = "RDPSource"
const PARTIAL_CHARS = 48
const EAR = joinPath(dirname(fileURLToPath(import.meta.url)), "..", "bin", "huginn-ear.py")

type Line =
  | { type: "pid"; pid: number }
  | { type: "mic" }
  | { type: "ready"; model?: string; device?: string }
  | { type: "partial"; text: string }
  | { type: "phrase"; id: number; chunk: number; text: string }
  | { type: "final"; chunk: number; ids: number[]; text: string }
  | { type: "error"; message: string }
  | { type: "done" }

type State = "off" | "connecting" | "listening" | "stopping"

type Session = {
  child: ChildProcess
  ended: Promise<void>
  phrases: Map<number, string>
  finals: { old: string; text: string }[]
  failure: string
}

/** The part of OpenTUI's EditBufferRenderable that the plugin uses. */
type Box = {
  readonly plainText: string
  readonly isDestroyed?: boolean
  replaceText(text: string): void
  gotoBufferEnd?(): void
}

const isBox = (r: any): r is Box =>
  !!r && typeof r.plainText === "string" && typeof r.replaceText === "function"

export default Plugin.define({
  id: "huginn-voice",
  setup: ctx => {
    const options = (ctx.options ?? {}) as Record<string, unknown>
    const opt = (k: string) => (typeof options[k] === "string" ? (options[k] as string).trim() : "")
    const [state, setState] = createSignal<State>("off")
    const [partial, setPartial] = createSignal("")
    const stopKey = opt("key") || "alt+h"
    const theme: any = ctx.theme

    let box: Box | undefined
    let live: Session | undefined

    const alive = () => !!box && !box.isDestroyed
    const read = (): string => (alive() ? box!.plainText : "")
    const write = (text: string) => {
      if (!alive() || text === read()) return
      box!.replaceText(text)
      box!.gotoBufferEnd?.()
      ctx.renderer.requestRender?.()
    }

    // --- the band under the box ----------------------------------------------------------------------
    const band = () => {
      const s = state()
      if (s === "off") return null
      const p = partial()
      const head =
        s === "connecting" ? "◌ Huginn: connecting…"
        : s === "stopping" ? "◌ Huginn: finishing…"
        : p ? "● Huginn ›" : "● Huginn"
      const tail = s !== "listening" ? "" : p ? ` ${p.length > PARTIAL_CHARS ? "…" + p.slice(-PARTIAL_CHARS) : p}` : `  ${stopKey} stop · enter send`
      const muted = theme?.text?.muted
      const on = s === "listening" ? (theme?.text?.feedback?.success?.base ?? muted) : muted
      return (
        <box flexDirection="row">
          <text fg={on}>{head}</text>
          <text fg={muted}>{tail}</text>
        </box>
      )
    }
    const dropSlot = ctx.ui.slot({ append: "prompt.footer.status", render: () => <>{band()}</> })

    // --- the commands --------------------------------------------------------------------------------
    ctx.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "huginn.dictate",
          title: "Huginn: dictate / stop",
          description: "Dictate into the prompt (Huginn, your GPU). Again to stop without sending; Enter sends and stops.",
          group: "Huginn",
          palette: true,
          slash: { name: "huginn" },
          bind: stopKey,
          run: () => void toggle(),
        },
      ],
    }))
    // While listening, Enter is ours: stop, apply the finals, then send.
    ctx.keymap.layer(() => ({
      mode: "global",
      priority: 1000,
      enabled: () => state() === "listening" || state() === "connecting",
      commands: [{ id: "huginn.send", bind: "return", run: () => void halt(true) }],
    }))

    async function toggle() {
      if (live) return void halt(false)
      if (state() !== "off") return
      const focused = ctx.renderer.currentFocusedRenderable
      if (isBox(focused)) box = focused
      if (!alive()) {
        ctx.ui.toast.show({ variant: "warning", message: "Huginn: focus the prompt box first" })
        return
      }
      // A "/huginn" typed to start is a command, not text to keep.
      if (/^\s*\/huginn\s*$/.test(read())) write("")
      start()
    }

    function start() {
      const env: Record<string, string> = { ...(process.env as Record<string, string>) }
      env.HUGINN_URL = opt("url") || env.HUGINN_URL || DEFAULT_URL
      env.HUGINN_MIC = opt("mic") || env.HUGINN_MIC || DEFAULT_MIC
      env.HUGINN_SAVE = opt("save") || env.HUGINN_SAVE || "on"
      if (opt("api_key")) env.HUGINN_API_KEY = opt("api_key")
      const python = opt("python") || "python3"

      setState("connecting")
      setPartial("")
      const child = spawn(python, [EAR], { env, stdio: ["ignore", "pipe", "pipe"] })
      let resolveEnded = () => {}
      const session: Session = {
        child,
        ended: new Promise<void>(r => (resolveEnded = r)),
        phrases: new Map(),
        finals: [],
        failure: "",
      }
      live = session

      let buffered = ""
      child.stdout!.setEncoding("utf8")
      child.stdout!.on("data", (chunk: string) => {
        buffered += chunk
        let nl = buffered.indexOf("\n")
        while (nl >= 0) {
          const raw = buffered.slice(0, nl).trim()
          buffered = buffered.slice(nl + 1)
          nl = buffered.indexOf("\n")
          if (raw) onLine(session, raw)
        }
      })
      child.on("error", err => {
        session.failure = session.failure || `could not start the dictation client: ${String(err)}`
      })
      child.on("close", () => {
        if (session.failure) ctx.ui.toast.show({ variant: "error", message: `Huginn: ${session.failure}` })
        setPartial("")
        applyFinals(session)
        if (live === session) live = undefined
        setState("off")
        resolveEnded()
      })
    }

    function onLine(session: Session, raw: string) {
      let line: Line
      try {
        line = JSON.parse(raw) as Line
      } catch {
        return
      }
      if (line.type === "mic" || line.type === "ready") {
        if (state() === "connecting") setState("listening")
      } else if (line.type === "error") {
        session.failure = line.message
      } else if (line.type === "partial") {
        if (state() === "listening") setPartial(line.text)
      } else if (line.type === "phrase" && line.text) {
        session.phrases.set(line.id, line.text)
        setPartial("")
        write(joinText(read(), line.text))
      } else if (line.type === "final" && line.text) {
        const old = line.ids.map(id => session.phrases.get(id) ?? "").filter(Boolean).join(" ")
        if (old !== line.text) session.finals.push({ old, text: line.text })
      }
    }

    /** Stop listening; the finals land in the box in one step when the client ends. */
    async function halt(send: boolean) {
      const session = live
      if (!session) return
      setState("stopping")
      setPartial("")
      try {
        session.child.kill("SIGINT")
      } catch {
        /* already gone */
      }
      await Promise.race([session.ended, new Promise(r => setTimeout(r, STOP_WAIT_MS))])
      if (!send) return
      if (/^\s*\/huginn\s*$/.test(read())) return write("")
      if (read().trim()) ctx.keymap.dispatch("prompt.submit")
    }

    function applyFinals(session: Session) {
      let text = read()
      for (const f of session.finals) text = applyFinal(text, f.old, f.text) ?? text
      session.finals = []
      write(text)
    }

    return () => {
      dropSlot()
      try {
        live?.child.kill("SIGINT")
      } catch {
        /* gone */
      }
    }
  },
})

// --- the box arithmetic: the same rules as hooks/register.tsx ------------------------------------

/** A final with no phrases to replace (stop before the first pause) carries words never shown: append. */
export function applyFinal(hay: string, old: string, text: string): string | undefined {
  return old ? replaceLast(hay, old, text) : joinText(hay, text)
}

export function replaceLast(hay: string, old: string, text: string): string | undefined {
  const at = hay.lastIndexOf(old)
  return at < 0 ? undefined : hay.slice(0, at) + text + hay.slice(at + old.length)
}

export function joinText(a: string, b: string): string {
  if (!b) return a
  return a && !/\s$/.test(a) ? `${a} ${b}` : a + b
}
