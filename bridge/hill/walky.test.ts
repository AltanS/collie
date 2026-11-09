import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { SendResult, WalkyHost, WalkyPane } from "../walky/deliver.ts";
import { WalkyLog } from "../walky/log.ts";
import { WalkyService } from "../walky/service.ts";
import type { WalkyReceipt } from "../walky/types.ts";
import { deliveryOf, walkyPlace, walkySend } from "./walky.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const panes: WalkyPane[] = [
  { session: "main", paneId: "%1", agent: true, harness: "agent-x", label: "repo#one", state: "idle", activeAt: null, instance: "aaaa", terminal: true, off: false },
  { session: "main", paneId: "%2", agent: true, harness: "agent-y", label: "repo#two", state: "idle", activeAt: null, instance: "bbbb", terminal: true, off: false },
  { session: "main", paneId: "%3", agent: false, harness: null, label: "shell", state: "idle", activeAt: null, instance: "cccc", terminal: true, off: false },
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

  test("a session that ended (the token moved) is refused by walky and reports unknown", async () => {
    const typed: string[] = [];
    const send = walkySend(walky(() => ({ outcome: "sent" }), typed), { sleep: async () => undefined });
    expect(await send("local/%1#zzzz", "Answer", "Pixel 9")).toBe("unknown");
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
    expect(deliveryOf({ ...base, state: "refused", reason: "off" })).toBe("unknown");
    expect(deliveryOf(undefined)).toBe("unknown");
  });
});
