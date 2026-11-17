# 0091: An agent is started by id, with a request id and a receipt

- **Status:** Superseded by [ADR 0145](./0145-a-start-names-what-to-run-and-a-retry-lands-on-its-receipt.md) (2026-11-16)
- **Decided:** The bridge owns the list of startable agents, finds each binary on the login shell's PATH, and starts one by id with a request id and one receipt per id. Its rule that a failed launch stores nothing was replaced by the pending and unknown receipts (see ADR 0145), and its amendment of 2026-10-21 on the line in a send's receipt now lives in the header of `bridge/surface/requests.ts`.
- **Full text:** `git show 0741ed872:.adr/0091-launch-by-id-with-a-request-id.md`
