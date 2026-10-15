import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { Listening } from '../types'

/**
 * `/huginn` — dictate into the prompt box; Huginn transcribes on its own GPU while you speak.
 *
 *   /huginn          start listening
 *   …speak…          the band above the prompt previews the phrase you are saying (partial);
 *                    each phrase lands in the box at a pause (phrase); about every 20 s of audio
 *                    the phrases are replaced by a final text decoded like a recorded thought (final)
 *   Enter            finalizes what is still open, puts it in the prompt, sends, and stops
 *   [ Stop ]         the band: finalize and stop without sending (click, or ctrl+x tab, then Enter)
 *   (spoken stop)    a placeholder, OFF: see VOICE_STOP below
 *
 * A final replaces its phrases only where they still stand in the box as they were typed: if you
 * edited them by hand, your edit wins and the final is dropped.
 *
 * `bin/huginn-ear.py` does the work (ffmpeg → WebSocket /api/dictate → JSON lines); this module
 * starts it, stops it with SIGINT (the client then asks the server to finalize), and edits the box.
 */

type Line =
  | { type: 'pid'; pid: number }
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
  /** Set while a submit is waiting: phrases and finals go here instead of into the box. */
  late?: { phrases: string[]; finals: { old: string; text: string }[] }
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
    let text = e.text
    try {
      session.late = { phrases: [], finals: [] }
      await setStopping($)
      await stop($, session)
      text = join(text, session.late.phrases.join(' ').trim())
      for (const f of session.late.finals) text = replaceLast(text, f.old, f.text) ?? text
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
      <Box flexDirection="column">
        <Box>
          <Text color={now.state === 'listening' ? 'success' : undefined} dimColor={now.state !== 'listening'}>
            {head}
          </Text>
          {now.state !== 'stopping' && <Button key="stop" label="Stop" hotkey="s" onPress={() => void halt($)} />}
        </Box>
        {now.state === 'listening' && now.preview ? (
          <Text dimColor italic>
            {`  … ${now.preview}`}
          </Text>
        ) : null}
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
  await update($, listening, (s): Listening => ({ ...s, state: 'stopping', preview: undefined }))
}

async function setPreview($: EngineInterface, preview: string | undefined): Promise<void> {
  await update($, listening, (s): Listening => (s.state === 'listening' ? { ...s, preview } : s))
}

function start($: EngineInterface, options: PluginOptions): Session {
  // An empty field means the default: the config screen saves '' when a field is left blank.
  const env: Record<string, string> = {
    HUGINN_URL: str(options.url) || DEFAULT_URL,
    HUGINN_MIC: str(options.mic) || DEFAULT_MIC,
  }
  if (str(options.api_key)) env.HUGINN_API_KEY = str(options.api_key)
  const python = str(options.python) || 'python3'

  let resolveEnded: () => void = () => {}
  const session: Session = { ended: new Promise<void>(r => (resolveEnded = r)), phrases: new Map() }

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
          } else if (line.type === 'ready') {
            await setListening($, { state: 'listening', detail: [line.model, line.device].filter(Boolean).join(' · ') })
          } else if (line.type === 'error') {
            failure = line.message
          } else if (line.type === 'partial') {
            if (!session.stopRequested) await setPreview($, line.text)
          } else if (line.type === 'phrase' && line.text) {
            await setPreview($, undefined)
            if (!session.stopRequested && isStopWord(line.text)) {
              void halt($)
              continue
            }
            session.phrases.set(line.id, line.text)
            if (session.late) session.late.phrases.push(line.text)
            else await append($, line.text)
          } else if (line.type === 'final' && line.text) {
            const old = line.ids.map(id => session.phrases.get(id) ?? '').filter(Boolean).join(' ')
            if (!old || old === line.text) continue
            if (session.late) session.late.finals.push({ old, text: line.text })
            else await replaceInBox($, old, line.text)
          }
        }
      }
    } catch (err) {
      failure = failure || `could not start the dictation client: ${String(err)}`
    } finally {
      if (failure) $.ui.toast(`Huginn: ${failure}`)
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

async function append($: EngineInterface, text: string): Promise<void> {
  const box = await $.prompt.read()
  await $.prompt.fill({ text: box.text && !/\s$/.test(box.text) ? ` ${text}` : text, mode: 'append' })
}

/** Replace the phrases a final covers, only where they still stand in the box unchanged. */
async function replaceInBox($: EngineInterface, old: string, text: string): Promise<void> {
  const box = await $.prompt.read()
  const next = replaceLast(box.text, old, text)
  if (next !== undefined) await $.prompt.fill({ text: next, mode: 'replace' })
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
