# 0098: pi questions are read by shape and footer

- **Status:** Accepted
- **Date:** 2026-10-12
- **Shipped in:** pending (1.20.1)
- **Trail:** [PR 397](https://github.com/AltanS/collie/pull/397) (a `pi` adapter with recipes for one
  question extension) · [issue 412](https://github.com/AltanS/collie/issues/412) (a `pi` adapter for
  OmO's built-in ask) · `web/src/lib/harness/pi/ask.ts`, `footer.ts`, `ASK_NOTES.md` ·
  `web/src/fixtures/panes/pi--*.txt` · [ADR 0009](./0009-a-generic-menu-is-driven-by-the-keys-it-names.md) ·
  [ADR 0053](./0053-an-unread-dialog-still-has-a-way-out.md) ·
  [ADR 0055](./0055-a-pointed-list-is-walked-then-confirmed.md) ·
  [ADR 0077](./0077-the-omp-ask-single-select-is-lifted-and-its-multi-select-is-not.md) ·
  [ADR 0080](./0080-a-pointed-list-is-walked-verified-then-confirmed.md)

## Context

Herdr reports stock pi and OmO (the Senpi engine) alike as `pi`. pi has no question tool of its
own. Questions come from extensions: pi's own `question` and `questionnaire` examples, OmO's
built-in ask, the unpublished one behind PR 397, and many more on npm. PR 397 and issue 412 each
brought a `pi` adapter with recipes for one of them, and the two cannot both be registered.

The screens share a shape: a dialog between two rules at the tail, numbered options with one
pointer, often a free-text row, and a footer that names the keys. They differ in what the keys do.
On stock pi Enter selects and digits do nothing. On OmO a digit answers one question and Enter
means "next". On OmO's multi-select Enter toggles. A recipe copied from one screen to another
answers the wrong thing.

## Decision

One reader serves every pi-family question screen, and it names no extension and no tool.

- It reads the dialog by its shape and fails closed. Anything it does not expect stays raw, with the
  Escape card when the footer names Escape.
- It takes the plan from the footer alone. Arrows that move and Enter that selects or confirms give
  walk, verify, commit (ADR 0080). `1-9 select`, with Enter not select and one question, gives the
  digit alone, a key the screen printed (ADR 0009). Digits named only as typed text give nothing.
  Escape is the Cancel row, in the footer's words.
- A tab page lifts only by the walk. A Submit page lifts as a review only when it names Enter as
  submit and every question has an answer.
- Multi-select stays raw. So does a pointer on the free-text row, and every inline answer editor.
  The phone never types into a dialog.

## Consequences

This closes off one grammar per extension, a digit the footer did not name, and typing into a
dialog. A new extension gets buttons when its screen has this shape and its footer uses these
words, with no code change. One with other words stays raw until its footer is read.

Multi-select waits for a published extension whose capture proves Space ticks and Enter confirms.

The screen is a fallback, not the goal. A Collie-owned stock pi extension can see every tool call
as data through pi's `tool_call` event (`toolName`, `input`), but no pi API lets it answer another
extension's `ctx.ui.custom` dialog, so answers to those stay keys. OmO's built-in ask also publishes
the open question on an authenticated local control endpoint (`<agentDir>/rpc/tui/*.sock`, a 0600
secret, `get_state` and `subscribe` to read, `extension_ui_response` to answer, per senpi's
`docs/rpc.md`). That is a structured path for OmO, read from the source and not yet verified; taking
it is a separate decision, because an answer through it is an action from an emitter
([ADR 0024](./0024-a-beacon-is-a-hint-never-a-control-channel.md)).
Every pi screen without such a path keeps this reader.

## Amendment — 2026-10-12: pickers are dialogs by their hint row, and OmO's side panel is cropped

Status: **Accepted** (2026-10-12). Amends the Decision above for two screens it did not cover.
Trail: [issue 416](https://github.com/AltanS/collie/issues/416) · the side-panel comment on
[issue 412](https://github.com/AltanS/collie/issues/412) · `web/src/lib/harness/pi/panel.ts`,
`ask.ts` (`pickerOnScreen`), `footer.ts` (`keyHintPairs`). Tested live and on captures against
OmO 5.1.30 (Senpi 2026.10.11) and stock pi 0.87.1 and 1.1.0, on Linux under Herdr 0.9.3.

### Pickers

pi's own `/model`, `/tree` and `/resume`, OmO's, and any selector an extension draws in the
editor's place, are dialogs: Chat shows the unread-dialog card with Escape, and the phone does not
type. A picker is told by its key-hint row alone, never by its title, its name or the extension
behind it. The row is painted and is nothing but two or more key/action pairs, joined by the
footers' separators or, as OmO's `/model` prints it, by single spaces with at least one chord or
arrow. In the single-space form a chord or an arrow always starts a pair, so a named key right after
a key is that key's action (`ctrl+d delete`). It stands in the frame at the tail, never in an OmO `❯` editor. A stock editor's rows are
typed text, which pi never paints, so a draft that happens to read like key hints is still a draft.

### The side panel

OmO's fullscreen side panel can run beside the editor and the dialogs, starting at the column where
the editor's rules end. The reader crops every row at that column when a rule runs straight into
text, or when a row of the frame at the tail is padded to that column and then carries text. The
column counts only when it is the run of the tail frame's own bottom rule and the sign is a row of
that frame, so a rule run into text in the agent's output, or a short one in a draft, crops nothing.
A pane without either sign is read as before. Whether Windows ConPTY pads the panel's rows the way
these signs expect is not verified. Nothing read from a cropped screen is bound, because the
bridge matches whole screen rows: a reply goes out as an unbound write and still waits for the
read-back before Enter, and a question there stays raw with the Escape card. Lifting it would need
the bridge to bind to cropped rows, which is a separate decision.

## Amendment, 2026-10-12: a question beside the side panel binds to its columns

Status: **Accepted** (2026-10-12). Amends the side panel paragraph above for questions only.
Trail: `web/src/lib/column-range.ts`, `harness/prompt-model.ts`
(`bindColumns`), `harness/pi/index.ts`, `bridge/prompt-binding.ts`, `bridge/server.ts`
(`expected_columns`). Tested on captures and live against OmO 5.1.30 in the tap rig.

The separate decision is taken, as a field of the shared prompt model and not as a pi case in the
bridge. `PromptModel.bindColumns` names the display columns of each row a grammar read its dialog
from. The phone sends it as the optional body field `expected_columns` beside `expected_prompt`, and
the bridge cuts every row of its fresh read to those columns, escapes kept, before both the text and
the style check. The bridge still holds no grammar: it cuts at two numbers the phone sent. A change
outside the range, such as the panel's clock, does not refuse the tap; a change inside it does.
Without the field nothing changes, and an older bridge that ignores it compares whole rows and
refuses the tap. The pi reader sets it only on a question card read from a cropped view, 0 to the
panel's column. A Submit page beside the panel stays raw, and the editor's bound prompt beside the
panel is still whole rows, so a reply there stays an unbound write.
