import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { loadConfig } from "../config.ts";
import { guard, HILL_OFF_TEXT, hillAnswersRoute } from "../server.ts";
import type { JsonValue } from "../json.ts";
import { HILL_ANSWER_RIGHT } from "./parse.ts";
import { askInput, askRig, ONE, posted, TWO, uuid } from "./ask-rig.ts";

// `POST /api/hill/answers` (Asks, 2026-11-22): the route around `answerAsks`, and its gate, the single
// answer's own.

const SERVER_CODE = readFileSync(join(import.meta.dir, "..", "server.ts"), "utf8")
  .split("\n")
  .filter((line) => !/^\s*(\/\/|\*|\/\*)/u.test(line))
  .join("\n");

const ctx = { device: "Pixel 9", deviceId: null, acceptEncoding: null };

function body(rid: number, answers: Array<{ id: string; intent: string; text?: string | null }>): JsonValue {
  return { rid: uuid(rid), answers };
}

describe("the gate of POST /api/hill/answers", () => {
  test("is the single answer's: the write level, asked before the body is read, and this machine only", () => {
    const at = SERVER_CODE.indexOf('pathname === "/api/hill/answers" && req.method === "POST"');
    expect(at).toBeGreaterThan(SERVER_CODE.indexOf("apiFrontGate(req, pathname, cfg, pairingGate)"));
    const route = SERVER_CODE.slice(at, at + 700);
    expect(route).toContain("browserGate(HILL_ANSWER_RIGHT)");
    expect(route.indexOf("if (denied) return denied;")).toBeLessThan(route.indexOf("req.json()"));
    expect(route.indexOf('host.kind === "member"')).toBeLessThan(route.indexOf("req.json()"));
  });

  test("a read-only device is refused with 403; a writer passes", () => {
    const c = { ...loadConfig({ HOME: "/tmp/collie-answers-home" }), deviceHeader: "x-device-id", deviceAllowlist: ["phone"], allowAnyHost: true };
    const headers = { host: "collie.ts.net", origin: "https://collie.ts.net", "content-type": "application/json" };
    const post = (device: string) => new Request("http://collie.ts.net/api/hill/answers", { method: "POST", headers: { ...headers, "x-device-id": device } });
    expect(guard(post("tablet"), c, HILL_ANSWER_RIGHT)!.status).toBe(403);
    expect(guard(post("phone"), c, HILL_ANSWER_RIGHT)).toBeNull();
  });
});

describe("POST /api/hill/answers", () => {
  test("200 with an item per ask, and a repeat of the rid answers the same and types nothing", async () => {
    const r = askRig();
    const a = posted(r.hill.post(ONE, askInput(1)));
    const b = posted(r.hill.post(ONE, askInput(2)));
    const send = body(90, [
      { id: a.id, intent: "edge" },
      { id: b.id, intent: "more-context", text: "What is Edge?" },
    ]);
    const res = await hillAnswersRoute(r.hill, send, ctx);
    expect(res.status).toBe(200);
    const result = await res.json();
    expect(result).toMatchObject({ rid: uuid(90), delivery: "typed", items: [{ id: a.id, code: "ok" }, { id: b.id, code: "ok" }] });
    expect(r.sent).toHaveLength(1);
    const again = await hillAnswersRoute(r.hill, send, ctx);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual(result);
    expect(r.sent).toHaveLength(1);
    const reused = await hillAnswersRoute(r.hill, body(90, [{ id: a.id, intent: "stable" }]), ctx);
    expect(reused.status).toBe(409);
    expect(await reused.json()).toMatchObject({ code: "rid_reused" });
  });

  test("a closed ask in the Send is reported gone, and the rest is typed", async () => {
    const r = askRig();
    const a = posted(r.hill.post(ONE, askInput(1)));
    const b = posted(r.hill.post(ONE, askInput(2)));
    r.hill.cancelAsk(ONE, a.id, { answered: true, because: null });
    const res = await hillAnswersRoute(
      r.hill,
      body(90, [
        { id: a.id, intent: "edge" },
        { id: b.id, intent: "edge" },
      ]),
      ctx,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ items: [{ id: a.id, code: "gone", state: "withdrawn" }, { id: b.id, code: "ok" }] });
    expect(r.sent).toHaveLength(1);
  });

  test("409 too_long with the characters over, and nothing closed", async () => {
    const r = askRig();
    const asks = [1, 2, 3].map((n) => posted(r.hill.post(ONE, askInput(n))));
    const res = await hillAnswersRoute(
      r.hill,
      body(
        90,
        asks.map((ask) => ({ id: ask.id, intent: "edge", text: "x".repeat(1500) })),
      ),
      ctx,
    );
    expect(res.status).toBe(409);
    const refusal = await res.json();
    expect(refusal).toMatchObject({ code: "too_long" });
    expect(refusal.over).toBeGreaterThan(0);
    for (const ask of asks) expect(r.store.get(ask.id)?.state).toBe("open");
    expect(r.sent).toHaveLength(0);
  });

  test("409 for the asks of two sender addresses in one Send", async () => {
    const r = askRig();
    const mine = posted(r.hill.post(ONE, askInput(1)));
    const theirs = posted(r.hill.post(TWO, askInput(2)));
    const res = await hillAnswersRoute(
      r.hill,
      body(90, [
        { id: mine.id, intent: "edge" },
        { id: theirs.id, intent: "edge" },
      ]),
      ctx,
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "mixed_sessions" });
    expect(r.store.get(mine.id)?.state).toBe("open");
  });

  test("400 for a body of another shape; 404 with no Hill", async () => {
    const r = askRig();
    for (const bad of [
      null,
      { rid: "nope", answers: [{ id: "ak_aaaaaaaaaaaa", intent: "edge" }] },
      { rid: uuid(1), answers: [] },
      { rid: uuid(1), answers: Array.from({ length: 6 }, (_, i) => ({ id: `ak_aaaaaaaaaaa${String(i)}`, intent: "edge" })) },
      { rid: uuid(1), answers: [{ id: "wt_aaaaaaaaaaaa", intent: "edge" }] },
      {
        rid: uuid(1),
        answers: [
          { id: "ak_aaaaaaaaaaaa", intent: "edge" },
          { id: "ak_aaaaaaaaaaaa", intent: "stable" },
        ],
      },
      { rid: uuid(1), answers: [{ id: "ak_aaaaaaaaaaaa", intent: "" }] },
      { rid: uuid(1), answers: [{ id: "ak_aaaaaaaaaaaa", intent: "edge", text: 4 }] },
    ]) {
      expect((await hillAnswersRoute(r.hill, bad, ctx)).status).toBe(400);
    }
    const none = await hillAnswersRoute(undefined, body(1, [{ id: "ak_aaaaaaaaaaaa", intent: "edge" }]), ctx);
    expect(none.status).toBe(404);
    expect(await none.text()).toBe(HILL_OFF_TEXT);
  });
});
