import { Schema } from "effect"
import { Ipc } from "@opencode/plugin/gui"

/** The dictation client's state, shared by every window. */
export const EarState = Schema.Struct({
  state: Schema.Literals(["off", "connecting", "listening", "stopping"]),
  /** Preview of the phrase being spoken; not kept. */
  partial: Schema.String,
  /** The window that started the session, or -1. Phrases go only to it. */
  owner: Schema.Number,
})

export type EarState = typeof EarState.Type

/**
 * The bridge between the main process, which runs `bin/huginn-ear.py` in WSL through `wsl.exe`, and the windows,
 * which write what it hears into the prompt box.
 */
export const Ear = Ipc.define({
  id: "huginn-voice.ear",
  state: EarState,
  methods: {
    start: {},
    stop: {},
  },
  events: {
    phrase: Schema.Struct({ id: Schema.Number, text: Schema.String }),
    final: Schema.Struct({ ids: Schema.Array(Schema.Number), text: Schema.String }),
    done: Schema.Struct({ failure: Schema.String }),
  },
})
