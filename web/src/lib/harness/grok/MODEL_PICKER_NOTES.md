# Grok `/model` picker, as measured

Measured on macOS with Grok Build `1.0.46 (2765805b9442) [stable]` (from `grok --version`), on
2026-10-08, in a Herdr test pane made for the purpose.

## One tap confirms only the current stage

`/model` shows three lists in turn: the model, the context window, then the reasoning effort. It is
not one menu that takes Enter until it closes.

| Screen | Key pressed | Read back | Capture |
|---|---|---|---|
| Model list, `❯` on Grok 4.7 | Down | `❯` moves to Grok 4.7 Fast; the model is unchanged | `grok--model-picker.txt`, `grok--model-picker-moved.txt` |
| Back on Grok 4.7 | Enter | The composer fills with `/model Grok 4.7` and the window list appears | `grok--model-window.txt` |
| Window list, `❯` on 256k | Down | `❯` moves to 500k; nothing is submitted | `grok--model-window-moved.txt` |
| Back on 256k | Enter | The composer fills with `/model Grok 4.7 256k` and the effort list appears | `grok--model-effort.txt` |
| Effort list, `❯` on High | Down | `❯` moves to Medium; nothing is submitted | `grok--model-effort-moved.txt` |
| Back on High | Enter | The command completes, the picker closes, the composer is empty; status still reads Grok 4.7 (high) | read back at the time, not kept as a fixture |
| Window list | Ctrl+C | The picker and the command draft are cleared, back to the plain composer | read back at the time, not kept as a fixture |

No working pane's model was switched for this. Each capture starts at the list's top border and keeps
the raw ANSI, with no local paths and no startup hook output.

## What is recognised, and what may be sent

Native choices are built only when all of these hold at once: the complete list, the counted top
border, the bottom border, a one-row `/model` composer and the `Enter:send` hint. The command prefix
and the row shape must agree with the stage (model, window or effort); the visible row count must
equal the top border's count, there is exactly one `❯`, and no choice repeats.

A choice reuses `pointerWalk` and the existing "move → fresh read-back → Enter" sequence. It invents
no digit keys and never presses Enter across stages. `signature` keeps the raw region; `coreSignature`
only replaces the list's cursor with a blank of the same width, keeping the models, descriptions,
windows, efforts, command draft and borders. All three real cursor-move captures are listed in
`walk-pairs.ts`, with no exception added and no test skipped.

The raw screen still goes to the send guard. While the picker is open an ordinary Send does not type.
Another command's completion list, an incomplete list, an unknown effort, and an old picker with new
output below it do not get this treatment. Whether the list wraps at either end was not measured, so
`clampedEnds` is not declared.
