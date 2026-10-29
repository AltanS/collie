# dsh (DeepSeek Harness) saved session

`session.v4.jsonl` was written by dsh-tui 0.17.0 (DeepSeek Harness session format v4, Linux) on 2026-10-27. dsh-tui ran in a throwaway Herdr pane in an empty scratch folder holding a two-line `README.md` and `notes.txt`, against a local OpenAI-compatible gateway (provider `litellm`, model `default`), and was driven by typed prompts and approval keys. Nothing here comes from a real user's sessions.

dsh stores this log as `session.v4.jsonl.zstd`, one Zstandard frame per append batch after a frame holding only the header row. The rows here are those frames decoded and joined, the same lines `compression: 'none'` would have written. The tests build both encodings from them.

| What happens | Rows |
| --- | --- |
| `/permission workspace-write`, run twice | `command/run`, `command/done`, a `user/message` with source `user-approval` |
| A `bash` call (`ls -la`) and a two-line answer | `assistant/message` with reasoning, text and tool-call blocks, `tool/call`, `job/*`, `tool/result` |
| A write outside the folder: the sandbox refuses, the agent asks to escalate, the approval is rejected | `approval/asked`, `approval/decided` (`rejected`), an error `tool/result` |
| A background job started with `run_in_background`, then its completion | a `user/message` with source `tool-jobs`, `job_output` |
| `/compact` | `compaction/start`, `compaction/summary`, `compaction/end`, a `compact-checkpoint` user row with `surfaceOp: {op: "replace"}` |
| One more turn: a `read` call and a reply ending in `Ça va? 日本語` | |

Changes made before checking in:

- Paths: the scratch folder is `/home/operator/project`, its session-root folder name is `--home-operator-project--`, and the home folder is `/home/operator`. The user and group in `ls -la` output read `operator`, and the host name reads `host`.
- The system prompt, and each `user/message` (and `agent/inbox/spliced` entry) whose source is `agent-instructions`, `runtime-context`, `skill-catalog`, `time-context` or `compact-checkpoint`, is replaced with `<source> shortened for the fixture`. Tests use that text to check that none of them reaches Chat or History. A skill catalog's `entries` list is emptied.
- Each `request/header` row's `header`, which carries the whole request (system prompt and every tool schema the session could call), is replaced with `request header shortened for the fixture`.

Everything else, including row ids, sequence numbers, timestamps, the streamed token chunks on each assistant row, the usage rows and the compaction summary, is as dsh-tui wrote it.
