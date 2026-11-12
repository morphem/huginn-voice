// The box arithmetic of opencode2/tui.tsx. Keep the two copies in step.

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

/** Quotes a value for a POSIX shell. */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}
