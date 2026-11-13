// The Collie mod's state contract: what it keeps in `$.state` across a reload of its own code.
//
// `taken` holds the ids of the last commands the mod acted on, newest last, at most 64. A reload resets
// the module's own variables but not this, so a command reaches the session once.

/** Command ids the mod acted on, newest last. */
export type CollieTaken = string[]

declare module 'claude-code' {
  interface PluginState {
    collie: { taken: CollieTaken }
  }
}
