// ── EVERY MUTATION NAMES THE CHANNEL THAT ACKNOWLEDGES IT ────────────────────────────────────────
//
// Collie has FOUR acknowledgement channels and they answer four different questions. One channel per
// question — a control that reaches for two is saying the same thing twice, and one that reaches for
// none has told the operator nothing (DESIGN.md §11):
//
//   • **Haptic buzz** — "did the glass register my tap?" Owned by hooks/use-action-echo.ts and
//     hooks/use-hold-repeat.ts, fired ON THE PRESS and never on the outcome. Not a value below: it
//     rides the echo and is never chosen per mutation.
//   • **`"echo"`** — "did the bridge accept MY action?" The ✓ / spinner / busy tone AT THE CONTROL.
//   • **`"status"`** — "what happened, and why not?" lib/status.ts, the floating layer.
//   • **`"inline"`** — the same question, answered in the control's own chrome, because the answer
//     outlives the operator's next interaction (a §11 contextual notice).
//   • **`"silent"`** — nothing is said, ON PURPOSE, because the screen already said it.
//
// The Collie orbit round is the fourth channel and appears nowhere here: it announces UNATTENDED
// events — something that happened while the operator was not acting — so by construction no entry
// in this file can own it.
//
// A `channel` names how ACCEPTANCE is acknowledged. Failure is `"status"` for everything, always,
// with the single exception of `"inline"` (which moved the failure, not deleted it) — that rule is
// not per-mutation and so is not restated per entry. lib/mutate.ts is the wrapper that keeps a throw
// from being swallowed where a call site has no error surface of its own.
//
// ── WHAT THIS FILE IS FOR, AND WHAT IT CANNOT DO ─────────────────────────────────────────────────
//
// It cannot verify that anything renders. No test here mounts a control, and none could: the
// acknowledgement for `closePane` is a spinner in a bottom sheet three components away, and
// asserting on it from a manifest would be asserting on a mock of itself.
//
// What it does is exactly what the pack-wire guard does for a protocol change (ADR 0025 — "the guard
// checks that a decision was recorded; it never says which one is right"). Add a mutating export to
// lib/api.ts next month and ack-manifest.test.ts FAILS until you write one classified line here. The
// line is then in the diff, and it gets reviewed. The guard cannot do the work for you; it can
// refuse to let you skip the decision. The failure mode it exists to prevent is not somebody
// classifying wrongly — it is somebody adding `POST /api/thing`, never once framing "how does the
// operator learn this landed?" as a question, and shipping a control that is silent on success and
// silent on failure. That was the state of three call sites before this file existed.
//
// The `why` is mandatory on EVERY entry, not only on `"silent"`. `"silent"` is the entry that most
// obviously needs defending, but "echo" and "status" are each a claim about where the operator is
// looking when the answer arrives, and a claim with no sentence under it is the one that rots first.

/** The four values an entry may take. `"silent"` is a decision, never a default. */
export type AckChannel = "echo" | "status" | "inline" | "silent";

export interface AckEntry {
  channel: AckChannel;
  /** One line. Why THIS channel, in terms of where the operator is looking and what they'd otherwise
   *  be left believing. Required — see the header. */
  why: string;
}

/**
 * One entry per mutating export of lib/api.ts. Keyed by the exported name, because that is what
 * ack-manifest.test.ts reads back out of the source; a rename is a manifest edit.
 */
export const ACK_MANIFEST = {
  sendReply: {
    channel: "echo",
    why: "The composer empties and the sent text appears in the mirror; the Send button holds its busy tone until the bridge has verified the reply landed (lib/reply-action.ts).",
  },
  sendKeys: {
    channel: "echo",
    // TWO paths reach this one export, and the second is the reason `"silent"` is a real value in
    // this file. An IMMEDIATE press echoes on its own button. A STAGED press does not, and the
    // sentence that earns it was written at components/nav-tray.tsx (`sendQueue`) before this
    // manifest existed — it is quoted below because this is now where a claim like that is reviewed:
    //
    //     "`take()` empties the queue synchronously, so the chips vanishing IS the receipt (and the
    //      strip itself unmounts unless a locked modifier holds it open) — a spinner there would
    //      have nothing left to render on."
    //
    // The entry is classified `"echo"` rather than `"silent"` because the classification names the
    // channel the EXPORT is acknowledged on, and the immediate path is the one that owns a control
    // with a phase to show. The staged path is silent by the argument above and nothing else.
    why: "The pressed key fills accent and takes a ✓ (components/nav-tray.tsx); the mirror is the truth about what the key DID but can be ~2s behind, which is the silence useActionEcho was built to end. The staged queue's Send stays silent — see the note above it.",
  },
  refreshNow: {
    channel: "silent",
    why: "It cannot fail in a way the operator could act on: it swallows its own throw by design (see its doc in lib/api.ts), and the revalidation that every caller runs immediately after is what reports the herd as it actually is.",
  },
  closePane: {
    channel: "echo",
    why: "The pane VANISHING from the strip is the outcome, so the echo carries only the acceptance — a success status would announce a fact the screen is already making, and the pane sheet closes before it could be read anyway.",
  },
  focusPane: {
    channel: "status",
    why: "The one act whose outcome lands on a screen the operator is not looking at (the terminal, ADR 0031) — nothing here can show it, so the phone has to say it.",
  },
  renamePane: {
    channel: "status",
    why: "The sheet closes on success and the new label only reaches the strip on the next poll, so at the moment of the tap there is nothing on screen that changed.",
  },
  renameTab: {
    channel: "status",
    why: "Same as renamePane, one dimension up: the sheet is gone and the tab strip has not re-rendered yet.",
  },
  closeTab: {
    channel: "echo",
    // TWO paths reach this export and they are acknowledged differently, the same way `sendKeys`
    // above is. Closing ANOTHER tab is the plain case the entry describes. Closing the tab you are
    // IN also NAVIGATES you — components/agent-chat.tsx's `closeCurrentTab` lands you on a
    // neighbouring tab of the space, or Home — and that is the `createTab` case, not this one: the
    // eye has already left the control, so an echo on a button inside a strip that is unmounting is
    // an acknowledgement drawn where nobody can be looking. That path therefore ALSO publishes a
    // status, which turns the mark's orbit one round.
    //
    // It stays classified `"echo"` because the classification names the channel the EXPORT is
    // acknowledged on, and the plain close is the path that owns a control with a phase to show —
    // the same reading `sendKeys` takes. The operator found this: "when closing a tab btw the orbit
    // is not spinning, why?"
    why: "Same as closePane, and the blast radius makes it matter more: the tab leaving the strip is the outcome, the echo is the acceptance of a tap that kills every pane inside it. Closing the tab you are IN navigates, so that path adds a status — see the note above it.",
  },
  createTab: {
    channel: "status",
    why: "The app navigates to the new pane, so the operator's eye has already left the control that was tapped; the status line is what names WHAT was created on arrival (hooks/use-spaces.ts).",
  },
  createWorkspace: {
    channel: "status",
    why: "Same navigation, same reason — the created thing is a whole screen away from the button that asked for it.",
  },
  setSnooze: {
    channel: "echo",
    why: "The spinner in the card is the acceptance and the revalidated description line under the title is the outcome, both inside the control the thumb is still on.",
  },
  setNotifyPrefs: {
    channel: "echo",
    why: "The switch flips optimistically under the thumb; the server's merged view then reconciles it, and a REVERT is paired with an error status because a switch that moves back in silence misinforms anyone who has stopped looking (hooks/use-notify-prefs.ts).",
  },
  checkForUpdates: {
    channel: "inline",
    why: "The answer — up to date, an offer, or 'the check itself failed' — is a standing fact about this install that belongs in the card that states it, and it must not fade out from under the operator (components/update-check-control.tsx).",
  },
  pairDevice: {
    channel: "inline",
    why: "A mistyped or expired code is a refusal the operator fixes IN the form, one field away, so the sentence belongs beside the field rather than floating over the page (components/paired-devices.tsx).",
  },
  revokeDevice: {
    channel: "inline",
    why: "A failed revoke leaves the row it was aimed at still on screen, and that row is the only place the message is unambiguous about WHICH device is still paired.",
  },
  uploadImage: {
    channel: "status",
    why: "Success appends a host path to the draft, which is easy to miss in a box the operator was already typing in, so the status line names what just went into it (components/composer.tsx).",
  },
  transcribeAudio: {
    channel: "echo",
    why: "The mic strip's `transcribing` phase holds while the clip is in flight and the transcript landing in the composer is the outcome; every refusal comes back as a VALUE and is spoken by the composer's onError on the status channel (hooks/use-stt-recorder.ts).",
  },
// `satisfies`, not an annotation: the KEYS stay known to the compiler (so a typo'd name is a type
// error at any reader, rather than a silent `undefined`), while every entry is still checked against
// the contract above. An open `Record<string, AckEntry>` annotation would throw that evidence away.
} satisfies Record<string, AckEntry>;
