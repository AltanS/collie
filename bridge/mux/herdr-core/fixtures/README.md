# Core observer snapshot captures

These are byte-faithful raw observer DATA captures from a **read-only** `terminal.attach`
(`observe: true`, `history: 0`) on isolated herdr-core **0.1.15** instances, captured 2026-10-31.
Pi **1.4.0** ran `@juicesharp/rpiv-ask-user-question` **2.15.0**, English/default bindings.
The questionnaire and all input are synthetic.

| Capture | Size | Evidence |
| --- | --- | --- |
| `rpiv-preview-v015` | 200 × 120 | Preview question; pending-wrap restoration reprints the final status `f`. |
| `rpiv-answer-v015` | 200 × 120 | Multiline custom answer, leading spaces, emoji and reverse-video software caret. |
| `rpiv-startup-bell-v015` | 59 × 40 | Pi startup during the fixture launch, before the question arrived; a live bell follows the complete first paint in the same DATA payload. |
| `rpiv-coalesced-cursor-v015` | 59 × 40 | Focused custom answer `Known answer.`; live cursor commands follow the complete first paint in the same DATA payload. |

Each `.screen.txt` is the independent `terminal.read { lines: 0 }` result for the same screen.
Files preserve trailing spaces and contain no added final newline. They are expected text, not
text derived from the snapshot conversion under test.

**DATA frames are not snapshot boundaries.** In the pinned core source, `viewers::first_paint`
appends win32-input mode and one OSC 7501 report per root/named status. `wire::Outbox` joins
queued bytes and divides them into 16 KiB DATA frames. It can split a first paint, or include live
bytes after it in the same frame. Tests must retain that distinction:

- Treating the preview paint as SGR alone duplicates its restored cell (`thinking offf`).
- Treating the whole coalesced cursor payload as one paint discards a valid editor.
- The conversion ends at the known metadata boundary. It does not interpret later live output.
- Each captured terminal had one root status report and no named records (`reports: 1`).
- Unknown controls inside the rendered body, a conflicting repeated cell, truncated required
  metadata and disagreement with the independent plain screen still refuse conversion.

Source: [first paint](https://github.com/herdrdev/herdr-core/blob/v0.1.15/crates/herdr-core/src/viewers.rs),
[queued bytes and frame chunks](https://github.com/herdrdev/herdr-core/blob/v0.1.15/crates/herdr-core/src/wire.rs).

The captures include the synthetic prompt and local fixture paths. No operator conversations or
live workspace were used. Raw payloads were reviewed and scanned for the actual provider key
before inclusion; none contained it. See `HC_API.md` for protocol ownership and the supported
boundary. Disposable rig teardown and credential removal are recorded with the validation evidence,
not inferred from a passing fixture test.
