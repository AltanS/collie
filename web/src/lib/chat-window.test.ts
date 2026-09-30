import { describe, expect, it } from "vitest";

import {
  CHAT_UNCHANGED,
  EMPTY_CHAT_WINDOW,
  mergeChat,
  type ChatAnswer,
  type ChatWindow,
} from "@/lib/chat-window";
import type { ChatEntry, ChatOlderBody, ChatWindowBody, PaneChatResponse } from "@/lib/types";

const GEN = 1_759_000_000_000;
const BASE = 1_000_000;

function entry(uuid: string, seq: number, text = uuid): ChatEntry {
  return {
    uuid,
    seq,
    ts: "2026-09-30T10:00:00.000Z",
    role: "assistant",
    parts: [{ kind: "text", text }],
  };
}

function live(body: Partial<ChatWindowBody> & { upserts: ChatEntry[] }): ChatAnswer {
  const window: ChatWindowBody = {
    page: "live",
    gen: GEN,
    rev: 1,
    head: BASE,
    oldest: BASE,
    hasOlder: false,
    ...body,
  };
  const answer: PaneChatResponse = { paneId: "w1:p1", available: true, ...window };
  return { outcome: "body", body: answer };
}

function older(body: Partial<ChatOlderBody> & { upserts: ChatEntry[] }): ChatAnswer {
  const page: ChatOlderBody = { page: "older", gen: GEN, hasOlder: false, ...body };
  const answer: PaneChatResponse = { paneId: "w1:p1", available: true, ...page };
  return { outcome: "body", body: answer };
}

/** A window holding three turns at the base numbering, current to rev 1. */
function held(): ChatWindow {
  return mergeChat(
    EMPTY_CHAT_WINDOW,
    live({
      head: BASE + 2,
      oldest: BASE,
      upserts: [entry("a", BASE), entry("b", BASE + 1), entry("c", BASE + 2)],
    }),
  );
}

const seqs = (window: ChatWindow): number[] => window.entries.map((e) => e.seq);
const uuids = (window: ChatWindow): string[] => window.entries.map((e) => e.uuid);
const texts = (window: ChatWindow): string[] =>
  window.entries.map((e) => (e.parts[0]?.kind === "text" ? e.parts[0].text : ""));

describe("mergeChat — the first answer", () => {
  it("takes the window's numbering, positions and turns", () => {
    const window = held();
    expect(window.status).toEqual({ kind: "live" });
    expect(window.gen).toBe(GEN);
    expect(window.rev).toBe(1);
    expect(window.head).toBe(BASE + 2);
    expect(uuids(window)).toEqual(["a", "b", "c"]);
  });
});

describe("mergeChat — rule 1: another gen replaces, never merges", () => {
  it("throws away every turn of the numbering it no longer holds", () => {
    const window = mergeChat(
      held(),
      live({ gen: GEN + 1, rev: 1, head: BASE, oldest: BASE, upserts: [entry("z", BASE)] }),
    );
    expect(window.gen).toBe(GEN + 1);
    expect(uuids(window)).toEqual(["z"]);
  });

  it("keeps everything when the gen is the one held", () => {
    const window = mergeChat(held(), live({ rev: 2, head: BASE + 3, upserts: [entry("d", BASE + 3)] }));
    expect(uuids(window)).toEqual(["a", "b", "c", "d"]);
    expect(window.rev).toBe(2);
  });
});

describe("mergeChat — rule 2: a turn that changed did not move", () => {
  it("overwrites in place and keeps the seq it already had", () => {
    // The answer carries a DIFFERENT seq for a uuid already held — what opencode does when it
    // re-emits a streaming reply whole. The held seq wins.
    const window = mergeChat(held(), live({ rev: 2, upserts: [entry("b", BASE + 99, "b edited")] }));
    expect(uuids(window)).toEqual(["a", "b", "c"]);
    expect(seqs(window)).toEqual([BASE, BASE + 1, BASE + 2]);
    expect(texts(window)).toEqual(["a", "b edited", "c"]);
  });

  it("takes the newer content of the turn, not just its position", () => {
    const window = mergeChat(held(), live({ rev: 2, upserts: [entry("a", BASE, "a with a result")] }));
    expect(texts(window)[0]).toBe("a with a result");
  });

  it("holds a turn once when a `?before=` page repeats one the live page sent", () => {
    const window = mergeChat(
      held(),
      older({ upserts: [entry("older", BASE - 1), entry("a", BASE + 42, "a again")] }),
    );
    expect(uuids(window)).toEqual(["older", "a", "b", "c"]);
    expect(seqs(window)).toEqual([BASE - 1, BASE, BASE + 1, BASE + 2]);
  });
});

describe("mergeChat — rule 3: a new turn goes in at its own seq", () => {
  it("does not append a `?before=` page, which numbers downward", () => {
    const window = mergeChat(
      held(),
      older({ upserts: [entry("x", BASE - 2), entry("y", BASE - 1)] }),
    );
    expect(uuids(window)).toEqual(["x", "y", "a", "b", "c"]);
    expect(seqs(window)).toEqual([BASE - 2, BASE - 1, BASE, BASE + 1, BASE + 2]);
  });

  it("places a turn that arrives below what is held — a tool result on a turn never paged in", () => {
    // A first paint is a screenful of a window that holds more, so an incremental answer can carry a
    // turn whose seq sits under the client's own front.
    const paint = mergeChat(
      EMPTY_CHAT_WINDOW,
      live({ head: BASE + 60, oldest: BASE, upserts: [entry("m", BASE + 59), entry("n", BASE + 60)] }),
    );
    const window = mergeChat(paint, live({ rev: 2, head: BASE + 60, upserts: [entry("old", BASE + 9)] }));
    expect(uuids(window)).toEqual(["old", "m", "n"]);
  });

  it("keeps the same array when an answer upserts nothing", () => {
    const before = held();
    const after = mergeChat(before, live({ rev: 2, upserts: [] }));
    expect(after.entries).toBe(before.entries);
    expect(after.rev).toBe(2);
  });
});

describe("mergeChat — a 304 is neither an error nor a change", () => {
  it("hands back the held value untouched and identical", () => {
    const before = held();
    expect(mergeChat(before, CHAT_UNCHANGED)).toBe(before);
  });

  it("is identical for an empty window too", () => {
    expect(mergeChat(EMPTY_CHAT_WINDOW, CHAT_UNCHANGED)).toBe(EMPTY_CHAT_WINDOW);
  });
});

describe("mergeChat — the two empty answers are different facts", () => {
  const unavailable: ChatAnswer = {
    outcome: "body",
    body: { paneId: "w1:p1", available: false, reason: "no-session" },
  };
  const stale: ChatAnswer = { outcome: "stale", message: "update this machine" };

  it("reads `available: false` as a pane with nothing to show", () => {
    expect(mergeChat(EMPTY_CHAT_WINDOW, unavailable).status).toEqual({
      kind: "unavailable",
      reason: "no-session",
    });
  });

  it("reads a 404 as a machine a release behind, carrying its own sentence", () => {
    expect(mergeChat(EMPTY_CHAT_WINDOW, stale).status).toEqual({
      kind: "stale",
      message: "update this machine",
    });
  });

  it("never gives the two the same status", () => {
    const one = mergeChat(EMPTY_CHAT_WINDOW, unavailable).status;
    const other = mergeChat(EMPTY_CHAT_WINDOW, stale).status;
    expect(one.kind).not.toBe(other.kind);
  });

  it("keeps the turns already held under either", () => {
    const before = held();
    expect(uuids(mergeChat(before, unavailable))).toEqual(["a", "b", "c"]);
    expect(uuids(mergeChat(before, stale))).toEqual(["a", "b", "c"]);
  });

  it("stays the same object when the status did not actually move", () => {
    const once = mergeChat(EMPTY_CHAT_WINDOW, stale);
    expect(mergeChat(once, stale)).toBe(once);
  });
});

describe("mergeChat — hasOlder and oldest are carried, not worked out twice", () => {
  it("offers older turns when a first paint sits above the window's own front", () => {
    const window = mergeChat(
      EMPTY_CHAT_WINDOW,
      live({ head: BASE + 99, oldest: BASE, hasOlder: false, upserts: [entry("tail", BASE + 99)] }),
    );
    expect(window.oldest).toBe(BASE + 99);
    expect(window.hasOlder).toBe(true);
  });

  it("takes the window's own answer when the client's front IS the window's front", () => {
    const window = mergeChat(
      EMPTY_CHAT_WINDOW,
      live({ head: BASE, oldest: BASE, hasOlder: true, upserts: [entry("a", BASE)] }),
    );
    expect(window.oldest).toBe(BASE);
    expect(window.hasOlder).toBe(true);
  });

  it("says no older turns when the window started at the log's own first row", () => {
    const window = held();
    expect(window.oldest).toBe(BASE);
    expect(window.hasOlder).toBe(false);
  });

  it("takes hasOlder off the `?before=` page and re-points oldest at it", () => {
    const window = mergeChat(held(), older({ hasOlder: true, upserts: [entry("x", BASE - 1)] }));
    expect(window.oldest).toBe(BASE - 1);
    expect(window.hasOlder).toBe(true);
  });

  it("keeps the page's answer through the next live poll, once past the window's front", () => {
    const paged = mergeChat(held(), older({ hasOlder: false, upserts: [entry("x", BASE - 1)] }));
    // The live window still says there is more behind ITS front — a position we are already below.
    const window = mergeChat(paged, live({ rev: 2, oldest: BASE, hasOlder: true, upserts: [] }));
    expect(window.oldest).toBe(BASE - 1);
    expect(window.hasOlder).toBe(false);
  });
});

describe("mergeChat — an older page in a numbering we no longer hold", () => {
  it("is thrown away whole rather than placed in the wrong thread", () => {
    const before = held();
    const window = mergeChat(before, older({ gen: GEN + 1, upserts: [entry("x", BASE - 1)] }));
    expect(window).toBe(before);
  });
});
