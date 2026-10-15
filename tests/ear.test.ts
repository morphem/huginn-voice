import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The dictation client is faked at `process.spawn`: it reports a pid, says ready, emits the given
// lines, then waits for the SIGINT the plugin sends through `process.run(['kill', '-INT', pid])`,
// emits the finalize lines, and ends — the order the real `bin/huginn-ear.py` emits.

type Ev = Record<string, unknown>

function quiet(on: On) {
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  return mock.clock(on)
}

const phrase = (id: number, text: string, chunk = 1): Ev => ({ type: 'phrase', id, chunk, text })
const final = (ids: number[], text: string, chunk = 1): Ev => ({ type: 'final', chunk, ids, text })
const partial = (text: string): Ev => ({ type: 'partial', text })

function fakeClient(onKill: Promise<void>, during: Ev[], atStop: Ev[]) {
  const lines = (evs: Ev[]) => evs.map(e => JSON.stringify(e) + '\n').join('')
  return async function* () {
    yield { stream: 'stdout' as const, text: '{"type":"pid","pid":4242}\n{"type":"ready","model":"large-v3","device":"cuda"}\n' }
    for (const e of during) yield { stream: 'stdout' as const, text: lines([e]) }
    await onKill
    yield { stream: 'stdout' as const, text: lines(atStop) + '{"type":"done"}\n' }
    return { value: { code: 0, signal: null } }
  }
}

function world(on: On, initial: string) {
  const w = { box: initial, sent: '', kills: [] as string[][], killed: () => {}, dim: [] as string[] }
  const onKill = new Promise<void>(r => (w.killed = r))
  on('process.run', async (_$, e) => {
    w.kills.push([...e.argv])
    w.killed()
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.read', async () => ({ value: { text: w.box, cursor: w.box.length } }))
  on('prompt.fill', async (_$, e) => {
    w.box = e.mode === 'append' ? w.box + e.text : e.text
    w.dim = (e.decorations ?? []).filter(d => d.dimColor).map(d => e.text.slice(d.start, d.end))
    return { isFilled: true, text: w.box, cursor: w.box.length }
  })
  on('prompt.submit', async (_$, e) => {
    w.sent = e.text
    return { text: e.text }
  })
  return { w, onKill }
}

test('phrases land in the box; Enter sends with the finalized tail and stops', async ($, on) => {
  const clock = quiet(on)
  const { w, onKill } = world(on, 'Fix the bug')
  on('process.spawn', fakeClient(onKill, [phrase(1, 'w pliku app.py')], [final([1], 'w pliku app.py. I dodaj test.')]))

  await $.command.run({ command: 'huginn', args: '' })
  await clock.settle()
  expect(w.box).toBe('Fix the bug w pliku app.py')

  await $.prompt.submit({ text: w.box })
  expect(w.kills).toEqual([['kill', '-INT', '4242']])
  expect(w.sent).toBe('Fix the bug w pliku app.py. I dodaj test.')
})

test('the preview is grey in the box and the phrase replaces it at the pause', async ($, on) => {
  const clock = quiet(on)
  const { w, onKill } = world(on, 'Fix the bug')
  let step: () => void = () => {}
  const stepped = new Promise<void>(r => (step = r))
  on('process.spawn', async function* () {
    const out = (e: Ev) => ({ stream: 'stdout' as const, text: JSON.stringify(e) + '\n' })
    yield { stream: 'stdout' as const, text: '{"type":"pid","pid":5}\n{"type":"ready"}\n' }
    yield out(partial('w pli'))
    yield out(partial('w pliku ap'))
    await stepped
    yield out(phrase(1, 'w pliku app.py'))
    await onKill
    yield { stream: 'stdout' as const, text: '{"type":"done"}\n' }
    return { value: { code: 0, signal: null } }
  })

  await $.command.run({ command: 'huginn', args: '' })
  await clock.settle()
  expect(w.box).toBe('Fix the bug w pliku ap')
  expect(w.dim).toEqual(['w pliku ap'])
  step()
  await clock.settle()
  expect(w.box).toBe('Fix the bug w pliku app.py')
  expect(w.dim).toEqual([])
  await $.command.run({ command: 'huginn', args: '' })   // [Stop]: end the session inside the test
})

test('Enter with a grey preview still in the box: the preview goes, the final covers its words', async ($, on) => {
  const clock = quiet(on)
  const { w, onKill } = world(on, '')
  on('process.spawn', fakeClient(onKill, [phrase(1, 'popraw test'), partial('i dod')], [final([1], 'Popraw test i dodaj asercję.')]))

  await $.command.run({ command: 'huginn', args: '' })
  await clock.settle()
  expect(w.box).toBe('popraw test i dod')
  await $.prompt.submit({ text: w.box })
  expect(w.sent).toBe('Popraw test i dodaj asercję.')
})

test('finals are held while he talks and swapped in at once on stop', async ($, on) => {
  const clock = quiet(on)
  const { w, onKill } = world(on, '')
  on('process.spawn', fakeClient(onKill, [phrase(1, 'pierwsze zdanie'), phrase(2, 'drugie zdanie'), final([1, 2], 'Pierwsze zdanie. Drugie zdanie.'), phrase(3, 'trzecie airflow', 2)], [final([3], 'Trzecie Airflow.', 2)]))

  await $.command.run({ command: 'huginn', args: '' })
  await clock.settle()
  expect(w.box).toBe('pierwsze zdanie drugie zdanie trzecie airflow')   // unchanged while talking
  expect(w.kills).toEqual([])

  await $.command.run({ command: 'huginn', args: '' })                    // [Stop]
  expect(w.box).toBe('Pierwsze zdanie. Drugie zdanie. Trzecie Airflow.')
  expect(w.sent).toBe('')
})

test('a final is dropped where the person edited its phrases by hand', async ($, on) => {
  const clock = quiet(on)
  const { w, onKill } = world(on, '')
  let editAt = () => {}
  const edited = new Promise<void>(r => (editAt = r))
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: '{"type":"pid","pid":7}\n' + JSON.stringify(phrase(1, 'łanki reloader')) + '\n' }
    await edited
    yield { stream: 'stdout' as const, text: JSON.stringify(final([1], 'Łanki reloader.')) + '\n' }
    await onKill
    yield { stream: 'stdout' as const, text: '{"type":"done"}\n' }
    return { value: { code: 0, signal: null } }
  })

  await $.command.run({ command: 'huginn', args: '' })
  await clock.settle()
  expect(w.box).toBe('łanki reloader')
  w.box = 'ONEKEY reloader'            // he fixed it himself
  editAt()
  await clock.settle()
  await $.command.run({ command: 'huginn', args: '' })   // [Stop]: the held final finds nothing to replace
  expect(w.box).toBe('ONEKEY reloader')
})

test('[Stop] before the first pause: the final carries words never shown and lands in the box', async ($, on) => {
  const clock = quiet(on)
  const { w, onKill } = world(on, '')
  on('process.spawn', fakeClient(onKill, [], [final([], 'Ostatnie słowa.')]))

  await $.command.run({ command: 'huginn', args: '' })
  await clock.settle()
  const stopped = await $.command.run({ command: 'huginn', args: '' })
  expect(stopped.text).toContain('stopped')
  expect(w.box).toBe('Ostatnie słowa.')
  expect(w.sent).toBe('')
})

test('a spoken stop word is OFF: „koniec” is typed like any phrase and listening goes on', async ($, on) => {
  const clock = quiet(on)
  const { w, onKill } = world(on, 'Popraw test')
  on('process.spawn', fakeClient(onKill, [phrase(1, 'w module ear'), phrase(2, 'Koniec.')], []))

  await $.command.run({ command: 'huginn', args: '' })
  await clock.settle()
  expect(w.kills).toEqual([])
  expect(w.box).toBe('Popraw test w module ear Koniec.')
})
