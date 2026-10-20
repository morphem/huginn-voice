import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Listening } from '../types'

/**
 * `/huginn` — dictate into the prompt box; Huginn transcribes on its own GPU while you speak.
 *
 *   /huginn          start listening
 *   …speak…          the phrase being spoken shows in the box in grey (partial); at a pause it is
 *                    replaced by the decoded phrase in plain text (phrase). The band above the prompt
 *                    stays one line, so the conversation above it never jumps. Meanwhile the server decodes
 *                    each ~12 s chunk again the way a recorded thought is decoded (final), in the
 *                    background; the plugin holds those finals so the text does not change under
 *                    your eyes while you talk
 *   Enter            finalizes what is still open, swaps in every final at once, sends, and stops
 *   [ Stop ]         the band: the same without sending (click, or ctrl+x tab, then Enter); the final
 *                    text replaces the dictated phrases in the box in one step
 *   (spoken stop)    a placeholder, OFF: see VOICE_STOP below
 *
 * A final replaces its phrases only where they still stand in the box as they were typed: if you
 * edited them by hand, your edit wins and the final is dropped.
 *
 * `bin/huginn-ear.py` does the work (ffmpeg → WebSocket /api/dictate → JSON lines); this module
 * starts it, stops it with SIGINT (the client then asks the server to finalize), and edits the box.
 * The band says "listening" as soon as the microphone is open: the client holds what is said while
 * it connects. Unless the `save` option is "off", the client also keeps the whole session as one
 * recording and, after stop, sends it to Huginn as a thought in the 'prompts' space.
 */

type Line =
  | { type: 'pid'; pid: number }
  | { type: 'mic' }
  | { type: 'ready'; model?: string; device?: string }
  | { type: 'partial'; text: string }
  | { type: 'phrase'; id: number; chunk: number; text: string }
  | { type: 'final'; chunk: number; ids: number[]; text: string }
  | { type: 'error'; message: string }
  | { type: 'done' }

type Session = {
  pid?: number
  ended: Promise<void>
  /** Phrase texts by id: what a final has to find in the box to replace. */
  phrases: Map<number, string>
  /** Finals as they arrive, held until stop: the phrases each replaces, and its text. */
  finals: { old: string; text: string }[]
  /** The grey preview now at the end of the box, exactly as inserted (separator included); '' if none. */
  preview: string
  /** Set while a submit is waiting: phrases go here instead of into the box. */
  late?: { phrases: string[] }
  /** A stop arrived before the child reported its pid: signal it the moment the pid arrives. */
  stopRequested?: boolean
}

const STOP_WAIT_MS = 15000
const DEFAULT_URL = 'https://huginn.prawdzik.eu'
const DEFAULT_MIC = 'RDPSource'

/**
 * Spoken stop — a placeholder, OFF. With it on, a phrase that is only one of STOP_WORDS stops
 * listening and is not typed into the box.
 *
 * Tested by the owner in v0.2.0: „koniec” stopped, „stop” did not. A likely cause, not yet
 * verified: the ear drops speech shorter than MIN_SPEECH_MS (400 ms) before it decodes, as a blip,
 * and a single-syllable „stop” falls under that; two-syllable „koniec” does not. The [Stop] button
 * covers the need, so the feature stays off until there is a reason to tune it.
 */
const VOICE_STOP = false
const STOP_WORDS = new Set(['stop', 'stop huginn', 'huginn stop', 'koniec', 'koniec nasłuchu'])

const listening = atom({ plugin: 'huginn-voice', key: 'listening' } as const, { state: 'off' } as Listening)

/** The one running client of this session, if any. */
let live: Session | undefined

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'huginn',
      description: 'Dictate into the prompt (Huginn, your GPU). Stop without sending: [Stop] above the prompt; Enter sends and stops.',
      immediate: true,
    })
    await setListening($, { state: 'off' })
    return next(e)
  })

  on('command.run', { command: 'huginn' }, async $ => {
    if (await halt($)) return { text: 'Huginn: stopped listening.' }
    await setListening($, { state: 'connecting' })
    live = start($, options)
    return { text: 'Huginn: connecting… speak once the band says listening. Stop without sending: [Stop] (click, or ctrl+x tab then Enter). Enter sends and stops.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const session = live
    if (!session || e.command) return next(e)
    let text = stripTail(e.text, session.preview)
    try {
      session.late = { phrases: [] }
      await setStopping($)
      await stop($, session)
      text = join(text, session.late.phrases.join(' ').trim())
      for (const f of session.finals) text = applyFinal(text, f.old, f.text) ?? text
    } catch {
      /* never let the ear block a prompt: send what was typed */
    }
    return next(text === e.text ? e : { ...e, text })
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const now = await read($, listening)
    if (now.state === 'off' || e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const head =
      now.state === 'connecting' ? '◌ Huginn: connecting…'
      : now.state === 'stopping' ? '◌ Huginn: finishing…'
      : `● Huginn listening${now.detail ? ` (${now.detail})` : ''} `
    return (
      <Box>
        <Text color={now.state === 'listening' ? 'success' : undefined} dimColor={now.state !== 'listening'}>
          {head}
        </Text>
        {now.state !== 'stopping' && <Button key="stop" label="Stop" hotkey="s" onPress={() => void halt($)} />}
      </Box>
    )
  })
}

async function halt($: EngineInterface): Promise<boolean> {
  if (!live) return false
  await setStopping($)
  await stop($, live)
  return true
}

async function setListening($: EngineInterface, value: Listening): Promise<void> {
  await update($, listening, (): Listening => value)
}

async function setStopping($: EngineInterface): Promise<void> {
  await update($, listening, (s): Listening => ({ ...s, state: 'stopping' }))
}

function start($: EngineInterface, options: PluginOptions): Session {
  // An empty field means the default: the config screen saves '' when a field is left blank.
  const env: Record<string, string> = {
    HUGINN_URL: str(options.url) || DEFAULT_URL,
    HUGINN_MIC: str(options.mic) || DEFAULT_MIC,
  }
  if (str(options.api_key)) env.HUGINN_API_KEY = str(options.api_key)
  env.HUGINN_SAVE = str(options.save) || 'on'
  const python = str(options.python) || 'python3'

  let resolveEnded: () => void = () => {}
  const session: Session = { ended: new Promise<void>(r => (resolveEnded = r)), phrases: new Map(), finals: [], preview: '' }

  void (async () => {
    let buffered = ''
    let failure = ''
    try {
      const child = $.process.spawn({ argv: [python, `${$.plugin.root}/bin/huginn-ear.py`], env })
      for await (const { stream, text } of child) {
        if (stream !== 'stdout') continue
        buffered += text
        let nl = buffered.indexOf('\n')
        while (nl >= 0) {
          const raw = buffered.slice(0, nl).trim()
          buffered = buffered.slice(nl + 1)
          nl = buffered.indexOf('\n')
          if (!raw) continue
          let line: Line
          try {
            line = JSON.parse(raw) as Line
          } catch {
            continue
          }
          if (line.type === 'pid') {
            session.pid = line.pid
            if (session.stopRequested) void interrupt($, line.pid)
          } else if (line.type === 'mic') {
            // Safe to speak: the client holds the audio until the server is ready.
            if (!session.stopRequested) await update($, listening, (s): Listening => (s.state === 'connecting' ? { ...s, state: 'listening' } : s))
          } else if (line.type === 'ready') {
            const detail = [line.model, line.device].filter(Boolean).join(' · ')
            if (!session.stopRequested) await update($, listening, (s): Listening => (s.state === 'stopping' ? s : { state: 'listening', detail }))
          } else if (line.type === 'error') {
            failure = line.message
          } else if (line.type === 'partial') {
            if (!session.stopRequested && !session.late) await putTail($, session, line.text, true)
          } else if (line.type === 'phrase' && line.text) {
            if (!session.stopRequested && isStopWord(line.text)) {
              await putTail($, session, '', false)
              void halt($)
              continue
            }
            session.phrases.set(line.id, line.text)
            if (session.late) session.late.phrases.push(line.text)
            else await putTail($, session, line.text, false)
          } else if (line.type === 'final' && line.text) {
            const old = line.ids.map(id => session.phrases.get(id) ?? '').filter(Boolean).join(' ')
            if (old === line.text) continue
            session.finals.push({ old, text: line.text })   // old '' = words never shown: appended
          }
        }
      }
    } catch (err) {
      failure = failure || `could not start the dictation client: ${String(err)}`
    } finally {
      if (failure) $.ui.toast(`Huginn: ${failure}`)
      // Stopped without sending: swap the held finals into the box in one step. (A submit applies
      // them to the prompt itself, in its own hook.)
      if (!session.late) {
        try {
          await putTail($, session, '', false)   // the grey preview goes; the final covers its words
        } catch {
          /* the box keeps it */
        }
        for (const f of session.finals) {
          try {
            await replaceInBox($, f.old, f.text)
          } catch {
            /* the box keeps the phrases */
          }
        }
      }
      if (live === session) live = undefined
      await setListening($, { state: 'off' })
      resolveEnded()
    }
  })()

  return session
}

async function stop($: EngineInterface, session: Session): Promise<void> {
  session.stopRequested = true
  if (session.pid) await interrupt($, session.pid)
  await Promise.race([session.ended, $.clock.sleep(STOP_WAIT_MS)])
}

async function interrupt($: EngineInterface, pid: number): Promise<void> {
  try {
    await $.process.run(['kill', '-INT', String(pid)])
  } catch {
    /* already gone */
  }
}

/**
 * Put `text` at the end of the box in place of the current grey preview: grey again (`dim`, the next
 * preview) or plain (`!dim`, a decoded phrase, which then stays). '' just removes the preview. Where
 * the box no longer ends with the preview (he typed after it), the preview is left and `text` is
 * appended.
 */
async function putTail($: EngineInterface, session: Session, text: string, dim: boolean): Promise<void> {
  const box = await $.prompt.read()
  const base = stripTail(box.text, session.preview)
  const sep = text && base && !/\s$/.test(base) ? ' ' : ''
  const tail = text ? sep + text : ''
  session.preview = dim ? tail : ''
  if (base === box.text && !tail) return
  await $.prompt.fill({
    text: base + tail,
    mode: 'replace',
    decorations: dim && tail ? [{ start: base.length + sep.length, end: base.length + tail.length, dimColor: true, italic: true }] : undefined,
  })
}

/** `hay` without `tail` at its end, or `hay` unchanged where it does not end with it. */
export function stripTail(hay: string, tail: string): string {
  return tail && hay.endsWith(tail) ? hay.slice(0, hay.length - tail.length) : hay
}

/** Replace the phrases a final covers, only where they still stand in the box unchanged. */
async function replaceInBox($: EngineInterface, old: string, text: string): Promise<void> {
  const box = await $.prompt.read()
  const next = applyFinal(box.text, old, text)
  if (next !== undefined) await $.prompt.fill({ text: next, mode: 'replace' })
}

/** A final with no phrases to replace (stop before the first pause) carries words never shown: append. */
export function applyFinal(hay: string, old: string, text: string): string | undefined {
  return old ? replaceLast(hay, old, text) : join(hay, text)
}

export function replaceLast(hay: string, old: string, text: string): string | undefined {
  const at = hay.lastIndexOf(old)
  return at < 0 ? undefined : hay.slice(0, at) + text + hay.slice(at + old.length)
}

export function isStopWord(text: string): boolean {
  return VOICE_STOP && STOP_WORDS.has(text.toLowerCase().replace(/[^\p{L}\s]/gu, ' ').replace(/\s+/g, ' ').trim())
}

function join(a: string, b: string): string {
  if (!b) return a
  return a && !/\s$/.test(a) ? `${a} ${b}` : a + b
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
