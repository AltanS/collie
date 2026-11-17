# MiniMax Code (`mcode`) saved session

`messages.jsonl` was written by MiniMax Code 0.7.7 (npm `@minimax-ai/code`, Linux) on 2026-11-15
(Asia/Seoul). mcode ran in a throwaway herdr-core 0.1.21 terminal (`hc run --bg mcode`) in an empty
scratch folder holding a `README.md` and a `notes.txt`, and was driven by typed prompts and a
`/quit`. Nothing here comes from a real user's sessions.

The model behind it was a local Anthropic-Messages stub (`mcode provider add --api-format
anthropic-messages`, pointed at `127.0.0.1`), because this capture was made without a MiniMax
account. The stub chose the tool call and said the two replies; **everything else is as mcode wrote
it** — row ids, timestamps, the `message` envelope, `canonicalTextRange` and the injected plumbing it
slices, the tool call and its result with their `details`, and the usage rows. A capture from a real
MiniMax account would differ in the model's words and in nothing this reader looks at.

`manifest.json` is the session folder's own manifest, beside the transcript. The folder also held
`llm-call.json` (the request bodies) and NFS `~` placeholder files; neither is kept, because the
reader reads neither.

| File | What it holds |
| --- | --- |
| `messages.jsonl` | One whole session, 6 rows: a spoken prompt inside the injected plumbing with `canonicalTextRange` around the words, an assistant `toolCall` (`bash`, `ls -la`), its `toolResult`, the assistant's reply, and a second turn after the person answered |
| `manifest.json` | The folder's manifest: session id, created/updated times, and the paths the folder keeps |

Changes made before checking in:

- Paths: the scratch working folder is `/home/operator/project`, the data folder is
  `/home/operator/.minimax`, and the background task's `rawOutputPath` sits under it.
- The `ls -la` output's owner and group read `operator operator`.

Everything else, including the row ids, the timestamps, the session id, the plumbing text on each
user row and its `canonicalTextRange`, is as MiniMax Code wrote it. The tests use the plumbing to
check that none of it reaches Chat or History.
