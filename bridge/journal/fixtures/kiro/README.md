# Kiro V3 saved sessions

These files were written by kiro-cli 2.32.0 (Linux, V3 engine, default agent) on 2026-10-18. Kiro ran in a throwaway Herdr session with `KIRO_HOME` set to an empty scratch folder, and was driven by typed prompts and approval keys. Nothing here comes from a real user's sessions.

| File | What it holds |
| --- | --- |
| `messages.jsonl` | One whole session, 82 rows: a plain reply, a shell call, a denied `fs_write`, a failed `read_file`, an allowed `str_replace`, a long reply steered while it ran, `/compact`, and one turn after it |
| `subagent.jsonl` | The last turn of a second session, from its user row on: a failed first try at a sub-agent, then an `introspect` sub-agent that answered |

Changes made before checking in:

- Paths: the scratch working folder is `/home/operator/project`, the scratch `KIRO_HOME` is `/home/operator/.kiro`, and the home folder is `/home/operator`.
- The `session_start` row's system prompt and each `agent_note` row's context are replaced with a short placeholder ending `shortened for the fixture`. Tests use that text to check that neither reaches Chat or History.

Everything else, including row ids, timestamps, the first row's `fetch_cloud_config` call, the steering rows and the usage rows, is as Kiro wrote it.
