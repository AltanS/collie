# 0128: native dialog edits read the complete seen value

- **Trail:** the RPIV phone-question fork request (`pr/rpiv-question-support`), which considered a
  replacement extension and an event relay, then approved the bounded readback probe instead of
  joining wrapped rows · `web/src/lib/harness/pi/ask.ts`, `pi/editor.ts` ·
  `web/src/lib/editor-action.ts` · `web/src/components/card-dock.tsx` ·
  `web/e2e/rig/editor-readback.test.ts`
- **Status:** Proposed
- **Date:** 2026-10-26
- **Amends in scope:** [0098](./0098-pi-questions-are-read-by-shape-and-footer.md) and
  [0113](./0113-an-askuserquestion-answer-is-typed-into-its-field.md)

## Context

`@juicesharp/rpiv-ask-user-question` supports native answer fields and question/global notes. Its
single-choice digits can answer immediately, its custom checkbox follows nonempty text rather than
an independent toggle, and its notes' Enter **and Escape save the trimmed native draft**. Copying
Claude's key sequence would promise the wrong operation.

Two real captures (`multi-field-wrap-soft` and `-hard`) contain identical text and styled bindings
but different logical line breaks. A static row join cannot supply an editable base. Resting notes
can contain only a first-line summary, while opening an editor can hide choices or replace a preview.
Keeping the draft in the currently detected card would discard it during those native transitions.

An event relay would introduce another transport and questionnaire representation; the investigated
package event path also omits previews and requires complete answers. That does not preserve the
requested native preview and explicit partial-submit workflow.

## Decision

Keep RPIV authoritative and retain one Pi-family reader and the existing dialog controls. Add only
optional capabilities; older adapters retain their current defaults.

- Let the pure adapter observe a complete native editor and declare its measured read/clear/close
  plans. Shared actions own pane I/O. No replacement tool, companion extension, bridge grammar,
  new transport or dependency.
- Read a complete value with bounded, guarded cursor movements before opening a replacement draft.
  Keep display summaries read-only. Before erasing, re-read the full value, compare it to the seen
  value, and re-establish the original full dialog identity; closing/reopening a native note is an
  explicit saving transition, not read cleanup.
- Bind writes to fresh text **and style**, verify the replacement exactly, and acknowledge save or
  return. A refusal retains the phone draft. Return discards only that phone draft, never promises a
  rollback of native notes.
- Let the existing dock retain asked identity, draft and seen context only for the edit lifetime,
  scoped to pane/owner. Do not persist a competing answer map or fabricate hidden choices.
- Use the existing review's visible answer echoes and explicit Submit/Cancel. Declare a clipped
  summary separately from unanswered questions, warn about it, and leave hidden notes unknown until
  read. Partial submission never fills an unanswered question on the phone.

Initial measurement covers package 2.15.0, Pi 1.4.0, Linux/Herdr, English chrome and default bindings,
including 59-column stacked and 120/121-column wide layouts. An exact clipped default hint-template
prefix may declare only roles common to every matching measured template; the observed footer is
kept literal, and unknown or torn prefixes grant no such keys. Generic menus still emit only their
printed keys. Other unqualified Pi free-text rows remain untyped.

## Consequences

Complete reads cost cursor round trips: ordinary values take seconds, and a full note viewport can
be substantially slower. Clipping, oversized values, observed drift and unproved whitespace tails
refuse rather than truncate or guess. The public pane-API regressions audit reads against text,
erasure, Enter, Space and closure, and separately exercise guarded replacement/return.

This is **not a transaction**. Visible-grid bindings cannot reveal hidden concurrent edits or
indistinguishable successor invocations. Do not describe the seen context as a server token, or
advertise atomicity. A future authoritative protocol carrying the complete questionnaire, previews
and explicit partial state could replace cursor readback; a second answer store cannot.
