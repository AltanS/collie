import { describe, expect, test } from "bun:test";

import { refFor } from "./journal-probe.ts";

describe("refFor", () => {
  test("grok takes the session uuid from the parent directory, not the filename", () => {
    const id = "01a022f2-4cc2-7530-9af6-49009c6a024e";
    const path = `/Users/you/.grok/sessions/${encodeURIComponent("/Users/you/proj")}/${id}/chat_history.jsonl`;
    expect(refFor("grok", path)).toEqual({ kind: "id", value: id });
    // Filename-only extraction is the bug: chat_history.jsonl has no uuid, so a probe that looked
    // there reported "no logs found" for every real Grok session on the machine.
    expect(refFor("claude", path)).toBeNull();
  });

  test("claude still reads the uuid out of the filename", () => {
    const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    expect(refFor("claude", `/projects/-Users-you-proj/${id}.jsonl`)).toEqual({
      kind: "id",
      value: id,
    });
  });

  test("pi is a path ref, not an id", () => {
    const path = "/sessions/--repo--/2026-08-21T00-00-00-000Z_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.jsonl";
    expect(refFor("pi", path)).toEqual({ kind: "path", value: path });
  });

  test("a grok path whose parent is not a uuid is skipped, not guessed", () => {
    expect(refFor("grok", "/tmp/sessions/not-a-uuid/chat_history.jsonl")).toBeNull();
  });
});
