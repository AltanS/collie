import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SendResult, WalkyHost, WalkyPane } from "../walky/deliver.ts";
import { WalkyLog } from "../walky/log.ts";
import { WalkyService } from "../walky/service.ts";
import type { WalkyReceipt } from "../walky/types.ts";
import { HillStore } from "./store.ts";
import { memoryHillReceipts } from "./receipts.ts";
import { HillService } from "./service.ts";
import { hillSessionName, OneLook, deliveryOf, walkyPlace, walkySend } from "./walky.ts";

import { spaceOf } from "../walky/space.ts";

/** One unnamed space on one machine: every fixture pane shares it, and no rule reads it yet. */
const SOLO_SPACE = spaceOf({ memberId: "local", spaceId: "w1", spaceLabel: "w1" });

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const panes: WalkyPane[] = [
  { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false, space: SOLO_SPACE },
  { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#two", state: "idle", activeAt: null, instance: "bbbb", terminal: true, off: false, space: SOLO_SPACE },
  { session: "main", paneId: "%3", agent: false, harness: null, label: "shell", state: "idle", activeAt: null, instance: "cccc", terminal: true, off: false, space: SOLO_SPACE },
];

function walky(answer: () => SendResult, typed: string[] = [], memberId: string | null = null): WalkyService {
  const root = mkdtempSync(join(tmpdir(), "hill-walky-"));
  roots.push(root);
  const host: WalkyHost = {
    panes: () => panes,
    send: async (_pane, _id, text) => {
      typed.push(text);
      return answer();
    },
    sendState: () => answer(),
    cancelHeld: () => undefined,
  };
  return new WalkyService({ log: new WalkyLog(join(root, "walky")), host, memberId, enabled: () => true, machine: "desk", keyPem: () => null });
}

describe("the probe: which live session an address names", () => {
  test("a bare address resolves to the session holding the pane now, with its token; a token must match", () => {
    const place = walkyPlace(walky(() => ({ outcome: "sent" })), null);
    expect(place("local/%2")).toEqual({ address: "local/%2#bbbb", label: "repo#two", host: "desk", unattended: false });
    expect(place("local/%2#bbbb")?.address).toBe("local/%2#bbbb");
    expect(place("local/%2#zzzz")).toBeNull();
    expect(place("local/%9")).toBeNull();
  });

  test("a shell pane, a scope and garbage are no target", () => {
    const place = walkyPlace(walky(() => ({ outcome: "sent" })), null);
    expect(place("local/%3")).toBeNull();
    expect(place("all")).toBeNull();
    expect(place("repo")).toBeNull();
    expect(place("not an address")).toBeNull();
  });

  test("on a crew machine, `local/` and the member id name the same panes", () => {
    const place = walkyPlace(walky(() => ({ outcome: "sent" }), [], "desk-1"), "desk-1");
    expect(place("local/%1")?.address).toBe("desk-1/%1#aaaa");
    expect(place("desk-1/%1#aaaa")?.address).toBe("desk-1/%1#aaaa");
  });

  test("the unattended probe is asked for the resolved address", () => {
    const place = walkyPlace(walky(() => ({ outcome: "sent" })), null, (address) => address === "local/%1#aaaa");
    expect(place("local/%1")?.unattended).toBe(true);
    expect(place("local/%2")?.unattended).toBe(false);
  });
});

describe("the send: one operator walky message", () => {
  test("types the header and the body as an operator's message, and reports typed", async () => {
    const typed: string[] = [];
    const send = walkySend(walky(() => ({ outcome: "sent" }), typed), { mintId: () => "wt_aaaaaaaaaaa1", sleep: async () => undefined });
    expect(await send("local/%1#aaaa", 'Answer to dc_k3m9x2p7q1ab "Ship?"\nOption: yes (Yes)', "Pixel 9")).toBe("typed");
    expect(typed).toEqual(['[walky-talky wt_aaaaaaaaaaa1] from operator (Pixel 9)\nAnswer to dc_k3m9x2p7q1ab "Ship?"\nOption: yes (Yes)']);
  });

  test("a session that ended (the token moved) is refused by walky and reports refused: nothing was typed", async () => {
    const typed: string[] = [];
    const send = walkySend(walky(() => ({ outcome: "sent" }), typed), { sleep: async () => undefined });
    expect(await send("local/%1#zzzz", "Answer", "Pixel 9")).toBe("refused");
    expect(typed).toEqual([]);
  });

  test("a receipt still bare at the bound reports unknown", async () => {
    let clock = 0;
    const fake = {
      send: async () => ({ ok: true as const, receipts: [{ id: "wt_aaaaaaaaaaa1", target: "local/%1", state: "accepted" as const, verified: "local" as const, at: 0, by: "solo" }] }),
      status: () => ({ receipts: [], message: null, elsewhere: [] }),
    };
    const send = walkySend(fake, {
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
      },
      waitMs: 1000,
    });
    expect(await send("local/%1#aaaa", "Answer", "Pixel 9")).toBe("unknown");
    expect(clock).toBeGreaterThanOrEqual(1000);
  });

  test("walky's receipt states map to the hill's delivery", () => {
    const base: WalkyReceipt = { id: "wt_aaaaaaaaaaa1", target: "local/%1", state: "accepted", verified: "local", at: 0, by: "solo" };
    expect(deliveryOf({ ...base, state: "delivered" })).toBe("typed");
    expect(deliveryOf({ ...base, reason: "turn running" })).toBe("held");
    expect(deliveryOf(base)).toBe("unknown");
    expect(deliveryOf({ ...base, state: "inbox-only", reason: "dialog" })).toBe("unknown");
    // C-S1: walky typed nothing, so the Hill opens the Decision again instead of closing it answered.
    expect(deliveryOf({ ...base, state: "refused", reason: "off" })).toBe("refused");
    expect(deliveryOf(undefined)).toBe("unknown");
  });
});

describe("one look per list", () => {
  test("OneLook reads the source every time outside a pass, once inside one, nested passes included", () => {
    let reads = 0;
    const look = new OneLook(() => (reads += 1));
    expect([look.read(), look.read()]).toEqual([1, 2]);
    expect(look.within(() => [look.read(), look.within(() => look.read()), look.read()])).toEqual([3, 3, 3]);
    expect(look.read()).toBe(4);
  });

  test("the list, the revision and the sweep resolve every decision against one who list", () => {
    const service = walky(() => ({ outcome: "sent" }));
    let whoCalls = 0;
    const who = new OneLook(() => {
      whoCalls += 1;
      return service.who();
    });
    const place = walkyPlace({ who: who.read }, null);
    let n = 0;
    const hill = new HillService({
      store: new HillStore(null, () => 1000),
      receipts: memoryHillReceipts(),
      place,
      sessionName: hillSessionName({ place, views: () => [], memberId: null, redact: false }),
      look: who.within,
      send: async () => "typed",
      crewMode: () => "solo",
      walkyOn: () => true,
      memberId: "m_aaaaaaaaaa",
      machine: "desk",
      now: () => 1000,
      mintId: () => `dc_look${String((n += 1)).padStart(8, "0")}`,
    });
    const sender = hill.agentSender(panes[0]!, "local/%1#aaaa");
    for (let i = 1; i <= 5; i += 1) {
      const posted = hill.post(sender, { requestId: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: "Ship it?", summary: "Green." });
      expect(posted.ok).toBe(true);
    }
    whoCalls = 0;
    expect(hill.list().open).toHaveLength(5);
    expect(whoCalls).toBe(1);
    whoCalls = 0;
    hill.rev();
    expect(whoCalls).toBe(1);
    whoCalls = 0;
    hill.sweep(2000);
    expect(whoCalls).toBe(1);
  });
});
