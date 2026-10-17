import { describe, expect, test } from "bun:test";
import { asJsonObject, parseJson, type JsonObject, type JsonValue } from "../../../web/src/lib/json";
import { PhoneClient, type FetchInit } from "./phone-client";

interface Call {
  readonly url: string;
  readonly init: FetchInit;
}

interface FakeBridge {
  readonly calls: Call[];
  readonly client: PhoneClient;
}

/** A fake bridge: answers by path, and keeps every call. */
function fakeBridge(answer: (path: string) => JsonValue): FakeBridge {
  const calls: Call[] = [];
  const client = new PhoneClient("http://127.0.0.1:41234", "tok-123", async (url, init) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(answer(url.slice("http://127.0.0.1:41234".length))), { status: 200 });
  });
  return { calls, client };
}

/** The JSON body of call `n`. */
const bodyOf = (calls: readonly Call[], n: number): JsonObject => asJsonObject(parseJson(calls[n]?.init.body ?? "")) ?? {};

const receipt = (outcome: string, extra: JsonObject = {}): JsonObject => ({ requestId: "x", outcome, keys: ["Enter"], ...extra });

describe("the phone's call shapes", () => {
  test("every request carries the bearer token, the bridge's own origin and the phone's XHR header", async () => {
    const { calls, client } = fakeBridge(() => ({ ok: true, pane: { paneId: "%3" } }));
    await client.createPane("/tmp/p", "phone-idle-send");
    const headers = calls[0]!.init.headers;
    expect(headers.authorization).toBe("Bearer tok-123");
    expect(headers.origin).toBe("http://127.0.0.1:41234");
    expect(headers["x-requested-with"]).toBe("XMLHttpRequest");
    expect(calls[0]!.init.method).toBe("POST");
    expect(bodyOf(calls, 0)).toEqual({ cwd: "/tmp/p", label: "phone-idle-send" });
  });

  test("a pane id is encoded in the path: tmux ids start with %", async () => {
    const { calls, client } = fakeBridge((path) => (path === "/api/workspace" ? { ok: true, pane: { paneId: "%3" } } : { ok: true, text: "" }));
    const pane = await client.createPane("/tmp/p", "x");
    await client.text(pane);
    await client.keys(pane, ["Escape"]);
    expect(calls[1]!.url).toEndWith("/api/pane/%253");
    expect(calls[2]!.url).toEndWith("/api/pane/%253/keys");
    expect(bodyOf(calls, 2)).toEqual({ keys: ["Escape"] });
  });

  test("an unconfirmed refusal is followed by the commit tap: a new id, the same text and mode, and the rows hash", async () => {
    let n = 0;
    const { calls, client } = fakeBridge((path) => {
      if (path === "/api/workspace") return { ok: true, pane: { paneId: "%1" } };
      n++;
      return n === 1 ? { receipt: receipt("refused", { reason: "unconfirmed" }), offers: ["commit", "keys"], rowsHash: "abc123" } : { receipt: receipt("sent"), offers: [] };
    });
    const pane = await client.createPane("/tmp/p", "x");
    const made = await client.sendAsPhone(pane, "exec /tmp/start.sh", "send");
    const first = bodyOf(calls, 1);
    const commit = bodyOf(calls, 2);
    expect(made.answers.map((answer) => answer.outcome)).toEqual(["refused", "sent"]);
    expect(commit.id).not.toBe(first.id);
    expect(commit.id).toBe(made.id);
    expect(commit).toMatchObject({ pane: "%1", text: "exec /tmp/start.sh", mode: "send", rowsHash: "abc123" });
    expect(first.rowsHash).toBeUndefined();
  });

  test("a commit that meets the cap is confirmed once more with capAck, on the hash of that answer", async () => {
    let n = 0;
    const { calls, client } = fakeBridge((path) => {
      if (path === "/api/workspace") return { ok: true, pane: { paneId: "%1" } };
      n++;
      if (n === 1) return { receipt: receipt("refused", { reason: "unconfirmed" }), offers: ["commit"], rowsHash: "h1" };
      if (n === 2) return { receipt: receipt("refused", { reason: "unconfirmed" }), offers: ["commit"], rowsHash: "h2", cap: { count: 5, limit: 5, harness: "shell", version: "-" } };
      return { receipt: receipt("sent"), offers: [] };
    });
    const pane = await client.createPane("/tmp/p", "x");
    const made = await client.sendAsPhone(pane, "exec /tmp/start.sh", "send");
    expect(made.answers.map((answer) => answer.outcome)).toEqual(["refused", "refused", "sent"]);
    expect(bodyOf(calls, 2).capAck).toBeUndefined();
    expect(bodyOf(calls, 3)).toMatchObject({ rowsHash: "h2", capAck: true, id: made.id });
  });

  test("Type is a reply with no submit: text into the pane, no Enter, no Send Protocol", async () => {
    const { calls, client } = fakeBridge((path) => (path === "/api/workspace" ? { ok: true, pane: { paneId: "%1" } } : { ok: true }));
    const pane = await client.createPane("/tmp/p", "x");
    expect(await client.type(pane, "/")).toBe(true);
    expect(calls[1]!.url).toEndWith("/api/pane/%251/reply");
    expect(bodyOf(calls, 1)).toEqual({ text: "/", submit: false });
  });

  test("an ask answer is a person's tap with the ask's hash", async () => {
    const { calls, client } = fakeBridge((path) => (path === "/api/workspace" ? { ok: true, pane: { paneId: "%1" } } : { receipt: { outcome: "sent", keys: ["3", "Enter"] } }));
    const pane = await client.createPane("/tmp/p", "x");
    const reply = await client.ask("ask-0123456789abcd", pane, "beef", "3");
    expect(calls[1]!.url).toEndWith("/api/ask/ask-0123456789abcd");
    expect(bodyOf(calls, 1)).toEqual({ pane: "%1", hash: "beef", optionId: "3", origin: "person_tap" });
    expect(reply).toMatchObject({ outcome: "sent", keys: ["3", "Enter"] });
  });

  test("the snapshot is narrowed to the pane, from agents or from shell panes", async () => {
    const surface = { revision: 4, turn: "idle", modal: "none", composer: "empty" };
    const { client } = fakeBridge((path) =>
      path === "/api/workspace" ? { ok: true, pane: { paneId: "%2" } } : { agents: [{ paneId: "%9", agent: "claude" }, { paneId: "%2", agent: "claude", status: "idle", surface, hooks: "live", sendProtocol: true, held: [{ requestId: "r1", state: "held" }] }], shellPanes: [] },
    );
    const pane = await client.createPane("/tmp/p", "x");
    expect(await client.pane(pane)).toEqual({ paneId: "%2", agent: "claude", status: "idle", surface: { revision: 4, turn: "idle", modal: "none", composer: "empty" }, hooks: "live", sendProtocol: true, held: [{ requestId: "r1", state: "held" }] });
  });
});

describe("the owned-pane rule", () => {
  test("a pane this client did not make is refused before any request", async () => {
    const { calls, client } = fakeBridge(() => ({}));
    await expect(client.send({ id: "id-12345678", pane: "%0", text: "hi", mode: "send" })).rejects.toThrow(/did not make it/);
    await expect(client.keys("%0", ["Escape"])).rejects.toThrow(/did not make it/);
    await expect(client.close("%0")).rejects.toThrow(/did not make it/);
    await expect(client.pane("%0")).rejects.toThrow(/did not make it/);
    expect(calls).toHaveLength(0);
  });

  test("a closed pane stops being the client's", async () => {
    const { client } = fakeBridge((path) => (path === "/api/workspace" ? { ok: true, pane: { paneId: "%5" } } : { ok: true }));
    const pane = await client.createPane("/tmp/p", "x");
    expect(await client.close(pane)).toBe(true);
    await expect(client.text(pane)).rejects.toThrow(/did not make it/);
  });

  test("a non-200 answer throws with the status", async () => {
    const client = new PhoneClient("http://127.0.0.1:41234", "t", async () => new Response("device not paired", { status: 403 }));
    await expect(client.config()).rejects.toThrow(/403: device not paired/);
  });
});
