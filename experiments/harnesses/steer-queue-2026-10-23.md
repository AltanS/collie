# Steer and queue mid-turn: pi 1.3.0, OMP 18.6.1, Codex 0.164.0 (2026-10-23)

M69 spec 01. Real screens, not docs. Fixtures: `web/src/fixtures/panes/{pi--v130,omp--v18-6,codex--v0164}-{steer,queue}-{typed,after-now,after,done}--w120.txt`,
labelled in `web/src/fixtures/surface-labels.json`, described in `web/src/fixtures/panes/README.md` ("Steer and queue mid-turn").

## Method

Slow task, one prompt per run: `Run this exact bash command with your bash tool, then say done: for i in $(seq 1 40); do echo $i; sleep 1; done`
(Codex: "shell command"). The turn runs about 40 s. After 8 to 10 s the line `also say hello at the end` was typed, captured (`typed`), then the
steer key (run 1) or the queue key (run 2) was pressed. Captures: at once (`after-now`, about 0.1 s), 2 s later (`after`), and after the
turn ended (`done`). Three model turns per harness (task, task, the queued follow-up). pi and OMP ran on `openrouter/anthropic/claude-haiku-4.5`.

## Findings

| Harness | Version | Steer key | Queue key | Screen within 2 s of the steer | Steer witness | Screen within 2 s of the queue | Queue witness | Surprise |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| pi | 1.3.0 | Enter | Alt+Enter | Box empty. A `Steering: <line>` row and `↳ Alt+Up to edit all queued messages` under the tool output. `── ⠦ Working ──` stays. | Row `Steering: <line>` (queue says `Follow-up:`). At 0.1 s only the empty box shows, the row is not drawn yet | Box empty. `Follow-up: <line>` row and the same `↳ Alt+Up` hint. | Row `Follow-up: <line>` | The steer did not interrupt the bash call. pi delivered the line after the tool call ended (40 s), and the agent answered it in the same turn (`Hello!` then `Done.`). The queue ran it as a second turn after `Done.` |
| OMP | 18.6.1 | Enter | Ctrl+Q | Box empty. The line stands in the transcript as a user message. The running tool box ends with `Backgrounded early to handle an incoming message; the command keeps running.` and `⟦Backgrounded: bg_1⟧`; the status bar gains `⚙ 1`. | Transcript user line plus `Backgrounded early to handle an incoming message` in the tool box. At 0.1 s the box still holds the line | Box empty. A block `After yield · 1` / `1. <line>` / `└ Alt+↑ to edit` above the spinner row. | Block `After yield · N` with a numbered row. At 0.1 s the box still holds the line | A steer moves the running tool call to the background (the tool is not killed). The agent then waits for the job, finishes, and answers the line in the same turn. The queue ran the line as a second turn after `Done.` |
| Codex | 0.164.0 | Enter | Tab | At 0.1 s: `Messages to be submitted after next tool call (press esc to interrupt and send immediately)` over `↳ <line>`. By 2 s that block is gone and the line stands in the transcript as `› <line>`; the box shows the placeholder again. | None as a row at 2 s. The line moving into the transcript (`› <line>`) with no `Queued follow-up inputs` block is the witness. At 0.1 s a `↳` row exists, with the steer header | Block `Queued follow-up inputs` / `↳ <line>` / `shift+← edit last queued message` under the `Working` row, still there after 2 s. | `Queued follow-up inputs` header, then `↳ <line>` | The `↳` glyph is NOT specific to a queue: a steer shows `↳ <line>` too for the first moment, under another header. Read the header, not the glyph. The steer did not interrupt the tool; the model answered the line after the tool call (`Done. Hello.`, one turn). The queue ran it as a second turn (`Worked for 2s`). Pasted text followed by a quick Enter is taken as a newline (paste burst): wait about a second between typing and Enter |

Common to all three: none interrupted the turn on Enter. Every steer was handled after the running tool call, not in the middle of it
(OMP by backgrounding the call). The box emptied on both keys. A reader that polls once at 0.1 s sees the old box on OMP and an empty box
without a row on pi; give the witness up to 2 s.

Proposed witnesses for spec 03 (measured here, not guessed):

- pi steer: a `Steering: ` row; queue: a `Follow-up: ` row.
- OMP steer: the line appears as a transcript user message with the box empty and no `After yield` block; queue: an `After yield · N` block.
- Codex steer: the line appears in the transcript as `› <line>` with no `Queued follow-up inputs` header; during the first moment a `Messages to be submitted after next tool call` header is also a steer witness. Queue: the `Queued follow-up inputs` header.

## Commands used

```sh
L=$HOME/.cache/collie-lab/m69-lab            # scratch, on disk; deleted after the run
tmux -L m69 -f /dev/null new -d -s m69lab -x 120 -y 40 "bash --norc"
tmux -L m69 set -g extended-keys on; tmux -L m69 set -g extended-keys-format csi-u; tmux -L m69 set -g escape-time 0
# start.sh per harness: isolated HOME, XDG_*, PI_CODING_AGENT_DIR, CODEX_HOME (copy of auth.json); HERDR_* unset;
# OPENROUTER_API_KEY read from collie-workspace/.env inside the script (never printed)
tmux -L m69 send-keys -t m69lab:0 "$L/pi/start.sh" Enter    # pi --provider openrouter --model anthropic/claude-haiku-4.5 --thinking off --offline --approve
                                                            # omp --approval-mode yolo ; codex (CODEX_HOME copy, project trusted)
tmux -L m69 send-keys -t m69lab:0 -l 'Run this exact bash command ...'; sleep 1; tmux -L m69 send-keys -t m69lab:0 Enter
tmux -L m69 send-keys -t m69lab:0 -l 'also say hello at the end'
tmux -L m69 capture-pane -t m69lab:0 -p -e > typed.ansi     # ANSI kept
tmux -L m69 send-keys -t m69lab:0 Enter                     # steer: pi Enter, OMP Enter, Codex Enter
tmux -L m69 send-keys -t m69lab:0 M-Enter                   # queue: pi Alt+Enter
tmux -L m69 send-keys -t m69lab:0 C-q                       # queue: OMP Ctrl+Q
tmux -L m69 send-keys -t m69lab:0 Tab                       # queue: Codex Tab
```

Fixtures were made length-preserving clean: the lab path `/var/home/altan/.cache/collie-lab/m69-lab` became
`/home/demo/sandbox/collie-labs/steerqueue` (and the OMP-shortened tail likewise). tmux needs `extended-keys` on with `csi-u` for pi's
Alt+Enter; the `-L m69` private server keeps the operator's own tmux untouched.
