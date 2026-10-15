/** What the band above the prompt shows while the ear is on. */
export type Listening = {
  state: 'off' | 'connecting' | 'listening' | 'stopping'
  /** The decoder, as the server reported it (`large-v3 · cuda`). */
  detail?: string
  /** The phrase being spoken right now (a greedy preview; never kept). */
  preview?: string
}

declare module 'claude-code' {
  interface PluginState {
    'huginn-voice': { listening: Listening }
  }
}
