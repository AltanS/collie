// The ceiling on the `lines` of a pane read, in one place: the phone's `GET /api/pane/:id` (server.ts)
// and the local API's `read` (api/reads.ts) clamp or refuse by the same number, so the two cannot drift.

/** The most lines one pane read may ask for. Not trusted from a client, and not from the multiplexer. */
export const MAX_READ_LINES = 10_000;
