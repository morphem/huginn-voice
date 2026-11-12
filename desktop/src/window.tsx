import { createSignal, untrack } from "solid-js"
import { Command, ComposerPill, type ComposerPillView, type Plugin } from "@opencode/plugin/gui"
import { Ear } from "./contract"
import { applyFinal, joinText } from "./text"

/**
 * The window side: a pill above the prompt box and a key start and stop dictation. Phrases go into the composer of the
 * session that was routed when dictation started, as they come; finals replace them when the client ends.
 */
export const setup: Plugin.Setup = (ctx) => {
  const ear = ctx.main(Ear)
  const options = (ctx.options ?? {}) as Record<string, unknown>
  const key = typeof options.key === "string" && options.key.trim() ? options.key.trim() : "alt+h"

  type Target = ReturnType<typeof ctx.screen.current>
  let target: NonNullable<Target>["composer"] | undefined
  let phrases = new Map<number, string>()
  let finals: { old: string; text: string }[] = []
  let send = false
  const [mine, setMine] = createSignal(false)

  const state = () => ear.state()?.state ?? "off"
  const busy = () => state() !== "off"

  const read = () => target?.text() ?? ""
  const write = (text: string) => {
    if (target && text !== untrack(read)) target.setText(text)
  }

  ear.on("phrase", (data) => {
    if (!target) return
    phrases.set(data.id, data.text)
    target.insert(joinText(untrack(read), data.text).slice(untrack(read).length))
  })

  ear.on("final", (data) => {
    const old = data.ids
      .map((id) => phrases.get(id) ?? "")
      .filter(Boolean)
      .join(" ")

    if (old !== data.text) finals.push({ old, text: data.text })
  })

  ear.on("done", (data) => {
    let text = untrack(read)

    for (const final of finals) text = applyFinal(text, final.old, final.text) ?? text
    write(text)
    if (data.failure) ctx.toast.show({ variant: "error", title: "Huginn", description: data.failure })

    const submit = send && !data.failure && !!text.trim()
    const composer = target

    phrases = new Map()
    finals = []
    send = false
    target = undefined
    setMine(false)
    if (submit && composer) void press(composer)
  })

  /** The composer has no submit method: focus it and press Enter, as the user would. */
  const press = async (composer: NonNullable<typeof target>) => {
    composer.focus()
    await new Promise((resolve) => requestAnimationFrame(resolve))

    const box = document.activeElement

    if (!box) return
    box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }))
  }

  const start = async () => {
    const composer = ctx.screen.current()?.composer

    if (!composer) {
      ctx.toast.show({ title: "Huginn", description: "Open a session first" })
      return
    }

    // A "/huginn" typed to start is a command, not text to keep.
    if (/^\s*\/huginn\s*$/.test(composer.text())) composer.setText("")
    target = composer
    phrases = new Map()
    finals = []
    send = false
    setMine(true)

    await ear.start().catch((error: unknown) => {
      target = undefined
      setMine(false)
      ctx.toast.show({ variant: "error", title: "Huginn", description: error instanceof Error ? error.message : String(error) })
    })
  }

  const stop = (andSend: boolean) => {
    send = andSend
    void ear.stop().catch(console.error)
  }

  const toggle = () => {
    if (state() === "off") return void start()
    if (mine() && (state() === "listening" || state() === "connecting")) stop(false)
  }

  ctx.add(
    Command,
    (): Command => ({
      id: "dictate",
      title: "Huginn: dictate / stop",
      description: "Dictate into the prompt (Huginn, your GPU). Again to stop without sending; Enter sends and stops.",
      group: "Huginn",
      section: "prompt",
      keywords: "voice dictation speech microphone",
      bind: key,
      editable: true,
      slash: { name: "huginn" },
      run: () => toggle(),
    }),
  )

  // While this window listens, Enter is ours: stop, apply the finals, then send.
  ctx.add(
    Command,
    (): Command => ({
      id: "send",
      title: "Huginn: stop and send",
      group: "Huginn",
      section: "prompt",
      bind: "enter",
      editable: true,
      hidden: true,
      run: () => {
        if (!mine() || (state() !== "listening" && state() !== "connecting")) return false
        stop(true)
      },
    }),
  )

  ctx.add(ComposerPill, {
    id: "dictate",
    show: (): ComposerPillView => {
      const current = state()
      const partial = ear.state()?.partial ?? ""

      if (current === "off") return { label: "Huginn", icon: "outline-audio", title: `Dictate (${key})`, run: toggle }
      if (!mine()) return { label: "Huginn: busy in another window", icon: "outline-audio", tone: "warning" }
      if (current === "connecting") return { label: "Huginn: connecting…", icon: "outline-wave-audio", tone: "warning", run: toggle }
      if (current === "stopping") return { label: "Huginn: finishing…", icon: "outline-wave-audio", tone: "warning" }

      return {
        label: partial ? `● ${partial.length > 48 ? "…" + partial.slice(-48) : partial}` : "● listening",
        icon: "outline-wave-audio",
        tone: "success",
        title: `Huginn is listening: ${key} stops, Enter sends`,
        run: toggle,
      }
    },
  })

  return () => {
    if (mine() && busy()) void ear.stop().catch(() => {})
  }
}
