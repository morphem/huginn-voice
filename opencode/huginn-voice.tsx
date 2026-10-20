/** @jsxImportSource @opentui/solid */
/**
 * `/huginn` for OpenCode — the same dictation as the Claude Code plugin (`hooks/register.tsx`), on
 * the same engine (`bin/huginn-ear.py` → Huginn's `/api/dictate`).
 *
 *   /huginn or alt+h   start listening (alt+h also works with text in the box)
 *   …speak…            the phrase being spoken shows in the band under the box (partial); at a pause
 *                      the decoded phrase is appended to the box (phrase). Finals (each ~12 s chunk
 *                      decoded like a recorded thought) are held while you talk
 *   Enter              finalizes, swaps in every final at once, sends, and stops
 *   alt+h              the same without sending (or /huginn on an empty box, or ctrl+p → Huginn)
 *
 * A final replaces its phrases only where they still stand in the box as they were typed: if you
 * edited them by hand, your edit wins and the final is dropped.
 *
 * How it reaches the box: this is a TUI plugin, so it replaces the `home_prompt` / `session_prompt`
 * slots with the host's own `api.ui.Prompt` and keeps its ref (read and write the text). While
 * listening it binds Enter in a layer of its own, so Enter stops and applies the finals BEFORE the
 * prompt is sent; the prompt's own onSubmit fires only after the box is already cleared.
 *
 * Options (tui.json tuple form, or the environment): api_key / HUGINN_API_KEY, url / HUGINN_URL,
 * mic / HUGINN_MIC, python, save / HUGINN_SAVE, key (default alt+h).
 */
import { spawn, type ChildProcess } from "child_process"
import { dirname, join as joinPath } from "path"
import { fileURLToPath } from "url"
import { createSignal } from "solid-js"

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

export default {
  id: "huginn-voice",
  tui: async (api: any, options: Record<string, unknown> | undefined) => {
    const opt = (k: string) => (typeof options?.[k] === "string" ? (options[k] as string).trim() : "")
    const [state, setState] = createSignal<State>("off")
    const [detail, setDetail] = createSignal("")
    const [partial, setPartial] = createSignal("")
    const stopKey = opt("key") || "alt+h"

    let ref: any
    let live: Session | undefined
    let enterLayer: (() => void) | undefined

    const read = (): string => ref?.current?.input ?? ""
    const write = (text: string) => {
      if (ref && text !== read()) ref.set({ ...ref.current, input: text })
    }

    // --- the prompt slot: the host's Prompt, our ref, our band as its hint -------------------------
    const band = () => {
      const s = state()
      if (s === "off") return undefined
      const p = partial()
      // One short line: it shares the footer row with OpenCode's own hints.
      const head =
        s === "connecting" ? "◌ Huginn: connecting…"
        : s === "stopping" ? "◌ Huginn: finishing…"
        : p ? "● Huginn ›" : "● Huginn"
      const tail = s !== "listening" ? "" : p ? ` ${p.length > PARTIAL_CHARS ? "…" + p.slice(-PARTIAL_CHARS) : p}` : `  ${stopKey} stop · enter send`
      return (
        <box flexDirection="row">
          <text fg={s === "listening" ? api.theme.current.success : api.theme.current.textMuted}>{head}</text>
          <text fg={api.theme.current.textMuted}>{tail}</text>
        </box>
      )
    }
    const prompt = (props: any, right: string) => (
      <api.ui.Prompt
        sessionID={props.session_id}
        visible={props.visible}
        disabled={props.disabled}
        onSubmit={() => props.on_submit?.()}
        ref={(r: any) => {
          ref = r
          props.ref?.(r)
        }}
        hint={band()}
        right={<api.ui.Slot name={right} session_id={props.session_id} />}
      />
    )
    api.slots.register({
      order: 50,
      slots: {
        home_prompt: (_ctx: any, props: any) => prompt(props, "home_prompt_right"),
        session_prompt: (_ctx: any, props: any) => prompt(props, "session_prompt_right"),
      },
    })

    // --- the commands -------------------------------------------------------------------------------
    api.command.register(() => [
      {
        title: "Huginn: dictate / stop",
        value: "huginn.dictate",
        description: "Dictate into the prompt (Huginn, your GPU). Again to stop without sending; Enter sends and stops.",
        category: "Huginn",
        slash: { name: "huginn" },
        keybind: stopKey,
        onSelect: () => void toggle(),
      },
    ])

    async function toggle() {
      if (live) return void halt(false)
      if (state() !== "off") return
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
      setDetail("")
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
      // While listening, Enter is ours: stop, apply the finals, then send.
      enterLayer = api.command.register(() => [
        { title: "Huginn: send", value: "huginn.send", hidden: true, keybind: "return", onSelect: () => void halt(true) },
      ])

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
        if (session.failure) api.ui.toast({ variant: "error", message: `Huginn: ${session.failure}` })
        setPartial("")
        applyFinals(session)
        if (live === session) live = undefined
        dropEnterLayer()
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
      if (line.type === "mic") {
        if (state() === "connecting") setState("listening")   // the client holds audio until ready
      } else if (line.type === "ready") {
        setDetail([line.model, line.device].filter(Boolean).join(" · "))
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
        if (old !== line.text) session.finals.push({ old, text: line.text })   // old '' = words never shown: appended
      }
    }

    /** Stop listening; the finals land in the box in one step when the client ends. */
    async function halt(send: boolean) {
      const session = live
      if (!session) return
      dropEnterLayer()
      setState("stopping")
      setPartial("")
      try {
        session.child.kill("SIGINT")   // the client finalizes, prints the last finals, exits
      } catch {
        /* already gone */
      }
      await Promise.race([session.ended, new Promise(r => setTimeout(r, STOP_WAIT_MS))])
      if (!send) return
      // A "/huginn" typed to stop is a command, not a prompt to send.
      if (/^\s*\/huginn\s*$/.test(read())) return write("")
      ref?.submit()
    }

    function applyFinals(session: Session) {
      let text = read()
      for (const f of session.finals) text = applyFinal(text, f.old, f.text) ?? text
      session.finals = []
      write(text)
    }

    function dropEnterLayer() {
      enterLayer?.()
      enterLayer = undefined
    }

    api.lifecycle?.onDispose?.(() => {
      try {
        live?.child.kill("SIGINT")
      } catch {
        /* gone */
      }
    })
  },
}

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
