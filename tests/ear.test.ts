import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// The ear client is faked at `process.spawn`: it reports a pid, says ready, hears one phrase, then
// waits for the SIGINT the plugin sends through `process.run(['kill', '-INT', pid])`, hears the
// last phrase (the flush) and ends — the order the real `bin/huginn-ear.py` emits.

function quiet(on: On) {
  on('ui.status', async () => ({ value: undefined }))
  on('ui.toast', async () => ({ value: undefined }))
  return mock.clock(on)
}

function fakeEar(onKill: Promise<void>, phrases: string[], last: string) {
  return async function* () {
    yield { stream: 'stdout' as const, text: '{"type":"pid","pid":4242}\n{"type":"ready","model":"large-v3","device":"cuda"}\n' }
    for (const p of phrases) yield { stream: 'stdout' as const, text: JSON.stringify({ type: 'heard', text: p }) + '\n' }
    await onKill
    yield { stream: 'stdout' as const, text: JSON.stringify({ type: 'heard', text: last }) + '\n{"type":"done"}\n' }
    return { value: { code: 0, signal: null } }
  }
}

test('phrases land in the box; Enter sends with the last phrase and stops', async ($, on) => {
  let box = 'Fix the bug'
  const kills: string[][] = []
  let killed: () => void = () => {}
  const onKill = new Promise<void>(r => (killed = r))
  let sent = ''

  const clock = quiet(on)
  on('process.spawn', fakeEar(onKill, ['w pliku app.py'], 'i dodaj test'))
  on('process.run', async (_$, e) => {
    kills.push([...e.argv])
    killed()
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.read', async () => ({ value: { text: box, cursor: box.length } }))
  on('prompt.fill', async (_$, e) => {
    box = e.mode === 'append' ? box + e.text : e.text
    return { isFilled: true, text: box, cursor: box.length }
  })
  on('prompt.submit', async (_$, e) => {
    sent = e.text
    return { text: e.text }
  })

  await $.command.run({ command: 'huginn', args: '' })
  await clock.settle()
  expect(box).toBe('Fix the bug w pliku app.py')

  await $.prompt.submit({ text: box })
  expect(kills).toEqual([['kill', '-INT', '4242']])
  expect(sent).toBe('Fix the bug w pliku app.py i dodaj test')
})

test('/huginn again stops without sending; the last phrase still lands in the box', async ($, on) => {
  let box = ''
  let killed: () => void = () => {}
  const onKill = new Promise<void>(r => (killed = r))

  const clock = quiet(on)
  on('process.spawn', fakeEar(onKill, [], 'ostatnie słowa'))
  on('process.run', async () => {
    killed()
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.read', async () => ({ value: { text: box, cursor: box.length } }))
  on('prompt.fill', async (_$, e) => {
    box = e.mode === 'append' ? box + e.text : e.text
    return { isFilled: true, text: box, cursor: box.length }
  })

  await $.command.run({ command: 'huginn', args: '' })
  await clock.settle()
  const stopped = await $.command.run({ command: 'huginn', args: '' })
  expect(stopped.text).toContain('stopped')
  expect(box).toBe('ostatnie słowa')
})

test('saying „stop” on its own stops listening and is not typed into the box', async ($, on) => {
  let box = 'Popraw test'
  const kills: string[][] = []
  let killed: () => void = () => {}
  const onKill = new Promise<void>(r => (killed = r))

  const clock = quiet(on)
  on('process.spawn', fakeEar(onKill, ['w module ear', 'Stop.'], ''))
  on('process.run', async (_$, e) => {
    kills.push([...e.argv])
    killed()
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('prompt.read', async () => ({ value: { text: box, cursor: box.length } }))
  on('prompt.fill', async (_$, e) => {
    box = e.mode === 'append' ? box + e.text : e.text
    return { isFilled: true, text: box, cursor: box.length }
  })

  await $.command.run({ command: 'huginn', args: '' })
  await clock.settle()
  await clock.advance(6000)
  expect(kills).toEqual([['kill', '-INT', '4242']])
  expect(box).toBe('Popraw test w module ear')
})
