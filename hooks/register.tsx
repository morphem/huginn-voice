import type { EngineInterface, PluginOptions, Register } from 'claude-code'

/**
 * `/huginn` — dictate into the prompt box through the Huginn ear.
 *
 *   /huginn          start listening; each phrase lands in the box about a second after you pause
 *   Enter            sends the prompt AND stops listening; the phrase still in flight is added first
 *   /huginn          (while listening) stop without sending; the last phrase lands in the box
 *
 * The audio goes to the Huginn server named in the options, never to a cloud service.
 * `bin/huginn-ear.py` does the work (ffmpeg → WebSocket → JSON lines); this module only starts it,
 * stops it with SIGINT (so it can flush the last phrase), and puts what it hears into the box.
 */

type Line =
  | { type: 'pid'; pid: number }
  | { type: 'ready'; model?: string; device?: string }
  | { type: 'heard'; text: string; decode_ms?: number }
  | { type: 'error'; message: string }
  | { type: 'done' }

type Session = {
  pid?: number
  ended: Promise<void>
  /** Set while a submit is waiting for the last phrase: phrases go here instead of into the box. */
  late?: string[]
  /** A stop arrived before the child reported its pid: signal it the moment the pid arrives. */
  stopRequested?: boolean
}

const STOP_WAIT_MS = 5000
const DEFAULT_URL = 'https://huginn.prawdzik.eu'
const DEFAULT_MIC = 'RDPSource'

export const register: Register = (on, options) => {
  let live: Session | undefined

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'huginn',
      description: 'Dictate into the prompt (Huginn ear, your GPU). Again to stop; Enter sends and stops.',
      immediate: true,
    })
    return next(e)
  })

  on('command.run', { command: 'huginn' }, async $ => {
    if (live) {
      await stop($, live)
      return { text: 'Huginn: stopped listening.' }
    }
    live = start($, options, () => {
      live = undefined
    })
    return { text: 'Huginn: connecting… speak once the status line says listening. Enter sends and stops.' }
  })

  on('prompt.submit', async ($, e, next) => {
    const session = live
    if (!session || e.command) return next(e)
    let tail = ''
    try {
      session.late = []
      await stop($, session)
      tail = session.late.join(' ').trim()
    } catch {
      /* never let the ear block a prompt: send what was typed */
    }
    return next(tail ? { ...e, text: join(e.text, tail) } : e)
  })
}

function start($: EngineInterface, options: PluginOptions, onEnd: () => void): Session {
  // An empty field means the default: the config screen saves '' when a field is left blank.
  const env: Record<string, string> = {
    HUGINN_URL: str(options.url) || DEFAULT_URL,
    HUGINN_MIC: str(options.mic) || DEFAULT_MIC,
  }
  if (str(options.api_key)) env.HUGINN_API_KEY = str(options.api_key)
  const python = str(options.python) || 'python3'

  let resolveEnded: () => void = () => {}
  const session: Session = { ended: new Promise<void>(r => (resolveEnded = r)) }
  $.ui.status('◌ Huginn: connecting…')

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
          }
          else if (line.type === 'ready') $.ui.status(`● Huginn listening (${line.model ?? 'ear'} · ${line.device ?? ''})`)
          else if (line.type === 'error') failure = line.message
          else if (line.type === 'heard' && line.text) {
            if (session.late) session.late.push(line.text)
            else await append($, line.text)
          }
        }
      }
    } catch (err) {
      failure = failure || `could not start the ear client: ${String(err)}`
    } finally {
      $.ui.status(undefined)
      if (failure) $.ui.toast(`Huginn: ${failure}`)
      onEnd()
      resolveEnded()
    }
  })()

  return session
}

async function stop($: EngineInterface, session: Session): Promise<void> {
  session.stopRequested = true
  $.ui.status('◌ Huginn: finishing the last phrase…')
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

function join(a: string, b: string): string {
  return a && !/\s$/.test(a) ? `${a} ${b}` : a + b
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}
