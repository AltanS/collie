// The lead masks a member's text answer before the phone reads it (CREW_PROTOCOL.md §9.1): a member
// one release behind sends its text in clear, and a lead that masks must not pass that on. Driven
// through `forwardToPeer` with the real mask, so each case is "what the phone gets through the lead".
// Placeholders only: the fake key is built at run time, so no key shape sits in this file.
import { describe, expect, test } from "bun:test";

import { maskChatBody, maskDiff, maskFileBody, maskHistoryPage, maskPaneRead, maskSnapshotTitles } from "../answer-mask.ts";
import type { ChatWindowBody } from "../journal/live.ts";
import type { TranscriptEntry } from "../journal/types.ts";
import type { ChangeDiff, FileReadAnswer, PaneReadResponse } from "../types.ts";
import { DEFAULT_MAX_UPLOAD_BYTES } from "../uploads.ts";
import { forwardToPeer, saltTag, textAnswerOf, unsaltIfNoneMatch, type ForwardDeps, type ForwardTransport } from "./forward.ts";
import { maskForwardedAnswer } from "./mask.ts";
import type { CrewLink, PeerOutcome } from "./peer-client.ts";
import type { PeerState } from "./registry.ts";

const key = `sk-test-placeholder-${"0".repeat(40)}`;
const masked = `sk-t${"•".repeat(key.length - 4)}`;
const blobUrl = `/api/blobs/${"ab".repeat(32)}`;
const dataUrl = `data:image/png;base64,iVBORw0KGgo${"A".repeat(40)}==`;
const ETAG = '"the-members-own-tag"';
/** The member's tag as the phone gets it through a lead that masks: salted with the mask's version. */
const SALTED = saltTag(ETAG);

const LINK: CrewLink = { memberId: "laptop", address: "laptop.example:8787" };
const REACHABLE: PeerState = {
  memberId: "laptop",
  health: "reachable",
  lastSeenAt: 1_754_000_000_000,
  reason: null,
  version: "1.17.2",
  conflict: null,
  preflight: null,
};

/** The member answers `body` with `status`, its own ETag, as JSON; `pulls` counts reads of the body. */
function member(body: string | Uint8Array | null, status = 200, contentType = "application/json; charset=utf-8") {
  const seen = { pulls: 0, headers: new Headers() };
  const transport: ForwardTransport = async (_link, _route, _params, init) => {
    seen.headers = new Headers(init.headers);
    const stream =
      body === null
        ? null
        : new ReadableStream<Uint8Array>({
            pull(controller) {
              seen.pulls += 1;
              controller.enqueue(typeof body === "string" ? new TextEncoder().encode(body) : body);
              controller.close();
            },
            // No read ahead: `pull` runs only when somebody reads, so `pulls` says who did.
          }, { highWaterMark: 0 });
    const res = new Response(stream, { status, headers: { "content-type": contentType, etag: ETAG } });
    const out: PeerOutcome<Response> = { ok: true, value: res, status, member: "laptop", receivedAt: 1, date: null };
    return out;
  };
  return { transport, seen };
}

/** One request through the lead, the mask on unless `mask` says otherwise. */
function viaLead(
  path: string,
  transport: ForwardTransport,
  opts: { mask?: ForwardDeps["mask"]; headers?: Record<string, string> } = { mask: maskForwardedAnswer },
) {
  const url = new URL(`https://lead.example${path}${path.includes("?") ? "&" : "?"}host=laptop`);
  return forwardToPeer(new Request(url, { headers: opts.headers ?? {} }), url, {
    link: LINK,
    state: REACHABLE,
    maxUploadBytes: DEFAULT_MAX_UPLOAD_BYTES,
    transport,
    mask: opts.mask,
  });
}

const entry: TranscriptEntry = {
  uuid: "u-1",
  ts: "2026-10-08T00:00:00Z",
  role: "assistant",
  parts: [
    { kind: "text", text: `the key is ${key}` },
    {
      kind: "tool",
      name: "Bash",
      id: "toolu_01",
      summary: `export OPENAI_API_KEY=${key}`,
      call: { kind: "execute", command: `curl -H "x-key: ${key}"` },
      result: { text: `echoed ${key}` },
    },
    { kind: "image", url: blobUrl, mimeType: "image/png" },
    { kind: "image", url: dataUrl, mimeType: "image/png" },
  ],
};

// What a member on 1.17 sends for each answer: the same shapes, in clear.
const paneRead: PaneReadResponse = { paneId: "w1:p1", text: `\u001b[2m$ cat .env\u001b[0m\nKEY=${key}\n`, truncated: false, revision: 7 };
const history = { paneId: "w1:p1", available: true as const, entries: [entry], hasMore: false, total: 1, fileTruncated: false };
const chatBody: ChatWindowBody = {
  page: "live",
  gen: 1,
  rev: 3,
  head: 1_000_001,
  oldest: 1_000_000,
  hasOlder: false,
  upserts: [{ ...entry, seq: 1_000_001 }],
  queued: [`use ${key} next`],
};
const chat = { paneId: "w1:p1", available: true as const, ...chatBody };
const diff: ChangeDiff = {
  available: true,
  repo: ".",
  path: ".env",
  status: "M",
  binary: false,
  directory: false,
  truncated: false,
  diff: `@@ -1 +1 @@\n-KEY=old\n+KEY=${key}\n`,
};
const fileText: FileReadAnswer = { available: true, root: "/home/a/p", path: ".env", size: 80, binary: false, truncated: false, text: `KEY=${key}\n` };

describe("which answers the lead masks", () => {
  test("the mirror, History, Chat, Changes and Files, by pane and by space; never a picture or a blob", () => {
    expect(textAnswerOf("pane/w1%3Ap1")).toBe("pane");
    expect(textAnswerOf("pane/w1%3Ap1/history")).toBe("history");
    expect(textAnswerOf("pane/w1%3Ap1/chat")).toBe("chat");
    expect(textAnswerOf("pane/w1%3Ap1/changes")).toBe("changes");
    expect(textAnswerOf("workspace/w1/changes")).toBe("changes");
    expect(textAnswerOf("pane/w1%3Ap1/files")).toBe("files");
    expect(textAnswerOf("workspace/w1/files")).toBe("files");
    for (const route of ["pane/w1/files/image", "workspace/w1/files/image", `blobs/${"ab".repeat(32)}`, "launchers", "folders", "pane/w1/reply", "tab"]) {
      expect(textAnswerOf(route)).toBeNull();
    }
  });
});

describe("a member's key reaches the phone masked through the lead", () => {
  const cases: [string, string, string][] = [
    ["the mirror", "/api/pane/w1:p1", JSON.stringify(paneRead)],
    ["a History page", "/api/pane/w1:p1/history", JSON.stringify(history)],
    ["a Chat window", "/api/pane/w1:p1/chat", JSON.stringify(chat)],
    ["a Chat older page", "/api/pane/w1:p1/chat", JSON.stringify({ paneId: "w1:p1", available: true, page: "older", gen: 1, upserts: [{ ...entry, seq: 999_999 }], hasOlder: false })],
    ["a Changes diff", "/api/pane/w1:p1/changes", JSON.stringify({ paneId: "w1:p1", ...diff })],
    ["a Changes diff asked by space", "/api/workspace/w1/changes", JSON.stringify({ workspaceId: "w1", ...diff })],
    ["a Files body", "/api/pane/w1:p1/files", JSON.stringify({ paneId: "w1:p1", ...fileText })],
    ["a Files body asked by space", "/api/workspace/w1/files", JSON.stringify({ workspaceId: "w1", ...fileText })],
  ];
  for (const [name, path, body] of cases) {
    test(name, async () => {
      expect(body).toContain(key);
      const res = await viaLead(path, member(body).transport);
      expect(res.status).toBe(200);
      const out = await res.text();
      expect(out).not.toContain(key);
      expect(out).toContain(masked);
      // The member's tag rides on, salted, so the member keeps answering the phone's If-None-Match.
      expect(res.headers.get("etag")).toBe(SALTED);
    });
  }

  test("ids, kinds and both picture addresses survive, and nothing is added or dropped", async () => {
    const res = await viaLead("/api/pane/w1:p1/history", member(JSON.stringify(history)).transport);
    // SAFETY: the lead re-serialised a History page; the assertions below read it field by field.
    const page = (await res.json()) as typeof history;
    const parts = page.entries[0]!.parts;
    expect(parts.map((p) => p.kind)).toEqual(["text", "tool", "image", "image"]);
    expect(parts[1]!.kind === "tool" && parts[1]!.id).toBe("toolu_01");
    expect(parts[2]).toEqual({ kind: "image", url: blobUrl, mimeType: "image/png" });
    expect(parts[3]).toEqual({ kind: "image", url: dataUrl, mimeType: "image/png" });
    expect(page.entries[0]!.uuid).toBe("u-1");
    expect(page.total).toBe(1);
  });

  test("the mirror keeps its escapes and its width", async () => {
    const res = await viaLead("/api/pane/w1:p1", member(JSON.stringify(paneRead)).transport);
    // SAFETY: the lead re-serialised a mirror read; `text` and `revision` are asserted below.
    const read = (await res.json()) as PaneReadResponse;
    expect(read.text).toHaveLength(paneRead.text.length);
    expect(read.text.startsWith("\u001b[2m$ cat .env\u001b[0m\n")).toBe(true);
    expect(read.revision).toBe(7);
  });

  test("the lead masks exactly what a 1.18 member masks: the same functions, the same bytes", () => {
    expect(maskForwardedAnswer("pane", JSON.stringify(paneRead))).toBe(JSON.stringify(maskPaneRead(paneRead)));
    expect(maskForwardedAnswer("history", JSON.stringify(history))).toBe(JSON.stringify(maskHistoryPage(history)));
    expect(maskForwardedAnswer("chat", JSON.stringify(chat))).toBe(JSON.stringify(maskChatBody(chat)));
    expect(maskForwardedAnswer("changes", JSON.stringify(diff))).toBe(JSON.stringify(maskDiff(diff, true)));
    expect(maskForwardedAnswer("files", JSON.stringify(fileText))).toBe(JSON.stringify(maskFileBody(fileText, true)));
  });

  test("the phone asked for gzip: the masked bytes are what is compressed", async () => {
    const res = await viaLead("/api/pane/w1:p1/chat", member(JSON.stringify(chat)).transport, {
      mask: maskForwardedAnswer,
      headers: { "accept-encoding": "gzip" },
    });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const out = await new Response(res.body!.pipeThrough(new DecompressionStream("gzip"))).text();
    expect(out).not.toContain(key);
    expect(out).toContain(masked);
  });
});

describe("an answer a 1.18 member already masked comes back byte for byte", () => {
  const already: [string, string, string][] = [
    ["the mirror", "/api/pane/w1:p1", JSON.stringify(maskPaneRead(paneRead))],
    ["a History page", "/api/pane/w1:p1/history", JSON.stringify(maskHistoryPage(history))],
    ["a Chat window", "/api/pane/w1:p1/chat", JSON.stringify(maskChatBody(chat))],
    ["a Changes diff", "/api/pane/w1:p1/changes", JSON.stringify({ paneId: "w1:p1", ...maskDiff(diff, true) })],
    ["a Files body", "/api/pane/w1:p1/files", JSON.stringify({ paneId: "w1:p1", ...maskFileBody(fileText, true) })],
  ];
  for (const [name, path, body] of already) {
    test(name, async () => {
      expect(body).not.toContain(key);
      const res = await viaLead(path, member(body).transport);
      expect(await res.text()).toBe(body);
      expect(res.headers.get("etag")).toBe(SALTED);
    });
  }

  test("an answer with nothing to mask is the member's own bytes, not a re-serialisation", () => {
    // Spacing a re-serialisation would drop: proof the bytes were handed back, not rebuilt.
    const unavailable = '{"paneId":"w1:p1", "available":false, "reason":"no-session"}';
    expect(maskForwardedAnswer("history", unavailable)).toBe(unavailable);
    expect(maskForwardedAnswer("chat", unavailable)).toBe(unavailable);
    const listing = '{"paneId":"w1:p1", "available":true, "root":"/r", "dir":"", "entries":[], "truncated":false}';
    expect(maskForwardedAnswer("files", listing)).toBe(listing);
    const changes = '{"paneId":"w1:p1", "available":true, "root":"/r", "repos":[]}';
    expect(maskForwardedAnswer("changes", changes)).toBe(changes);
  });
});

describe("a picture, a blob and every other route pass untouched and unread", () => {
  // A picture's bytes can hold anything, a key-shaped run included; they are not text and are never read.
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, ...new TextEncoder().encode(key)]);
  for (const path of ["/api/pane/w1:p1/files/image?path=a.png", "/api/workspace/w1/files/image?path=a.png", `/api/blobs/${"ab".repeat(32)}`]) {
    test(path, async () => {
      const { transport, seen } = member(png, 200, "image/png");
      const res = await viaLead(path, transport);
      expect(seen.pulls).toBe(0); // handed on, not read on the lead
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(png);
    });
  }

  test("the lead's mask off: a text answer is the member's bytes, as before", async () => {
    const body = JSON.stringify(chat);
    const { transport, seen } = member(body);
    const res = await viaLead("/api/pane/w1:p1/chat", transport, { mask: undefined });
    expect(seen.pulls).toBe(0);
    expect(await res.text()).toBe(body);
  });

  test("a member's 304 has no body and stays a 304 with its tag, salted", async () => {
    const res = await viaLead("/api/pane/w1:p1/chat", member(null, 304).transport);
    expect(res.status).toBe(304);
    expect(res.headers.get("etag")).toBe(SALTED);
  });

  test("a member's error answer is its own: no session text, so not read", async () => {
    const { transport, seen } = member('{"error":"unknown-path"}', 404);
    const res = await viaLead("/api/pane/w1:p1/files?path=nope", transport);
    expect(res.status).toBe(404);
    expect(seen.pulls).toBe(0);
    expect(await res.text()).toBe('{"error":"unknown-path"}');
  });
});

describe("fail closed: a body that should be masked and cannot be is never passed on", () => {
  const broken: [string, string, string][] = [
    ["not JSON", "/api/pane/w1:p1/chat", `KEY=${key}`],
    ["JSON but not an object", "/api/pane/w1:p1", JSON.stringify([key])],
    ["a mirror without its text", "/api/pane/w1:p1", JSON.stringify({ paneId: "w1:p1", lines: [key] })],
    ["a History page whose entries are not a list", "/api/pane/w1:p1/history", JSON.stringify({ available: true, entries: { a: key } })],
    ["a turn without its parts", "/api/pane/w1:p1/history", JSON.stringify({ available: true, entries: [{ uuid: "u", text: key }] })],
    ["an image whose url is not a string", "/api/pane/w1:p1/history", JSON.stringify({ available: true, entries: [{ parts: [{ kind: "image", url: { u: key } }] }] })],
    ["a Chat window without its queue", "/api/pane/w1:p1/chat", JSON.stringify({ ...chat, queued: undefined })],
    ["a History answer with no availability", "/api/pane/w1:p1/history", JSON.stringify({ entries: [entry] })],
    ["a diff that is not a string", "/api/pane/w1:p1/changes", JSON.stringify({ ...diff, diff: [key] })],
    ["a file text that is not a string", "/api/pane/w1:p1/files", JSON.stringify({ ...fileText, text: { t: key } })],
  ];
  for (const [name, path, body] of broken) {
    test(name, async () => {
      const res = await viaLead(path, member(body).transport);
      expect(res.status).toBe(502);
      const out = await res.text();
      expect(out).not.toContain(key);
      // SAFETY: a lead refusal is `forwardError`'s envelope; `code` and `host` are asserted.
      const refusal = JSON.parse(out) as { code: string; host: string };
      expect(refusal.code).toBe("answer_unmaskable");
      expect(refusal.host).toBe("laptop");
    });
  }
});

describe("the merged snapshot's titles", () => {
  test("a member's program-set title is masked; a label and a masked title are left as they are", () => {
    const snap = {
      agents: [
        { paneId: "w1:p1", terminalTitle: `vim ${key}` },
        { paneId: "w1:p2", terminalTitle: masked },
        { paneId: "w1:p3", label: `mine ${key}` },
      ],
      shellPanes: [{ paneId: "w1:p4", terminalTitle: `curl ${key}` }],
    };
    const out = maskSnapshotTitles(snap);
    expect(out.agents[0]!.terminalTitle).toBe(`vim ${masked}`);
    expect(out.agents[1]!.terminalTitle).toBe(masked);
    expect(out.agents[2]).toEqual(snap.agents[2]!);
    expect(out.shellPanes[0]!.terminalTitle).toBe(`curl ${masked}`);
  });
});

describe("a masked answer's tag names the mask's version", () => {
  test("the phone's salted tag reaches the member as the member's own", async () => {
    const { transport, seen } = member(null, 304);
    const res = await viaLead("/api/pane/w1:p1/chat", transport, {
      mask: maskForwardedAnswer,
      headers: { "if-none-match": SALTED },
    });
    expect(seen.headers.get("if-none-match")).toBe(ETAG);
    expect(res.status).toBe(304);
  });

  test("a tag without the salt is dropped, so a copy a lead passed on unmasked is fetched again", async () => {
    // A 1.17 lead passed the member's tag on bare, over a body it never masked. That tag must not buy
    // a 304 for the copy: the member answers in full, and this lead masks it.
    const body = JSON.stringify({ paneId: "w1:p1", text: key });
    const { transport, seen } = member(body);
    const res = await viaLead("/api/pane/w1:p1", transport, {
      mask: maskForwardedAnswer,
      headers: { "if-none-match": ETAG },
    });
    expect(seen.headers.get("if-none-match")).toBeNull();
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(key);
  });

  test("a tag salted under another version is dropped too", () => {
    expect(unsaltIfNoneMatch('"abc~m0"')).toBeNull();
    expect(unsaltIfNoneMatch(`"abc~m0", ${saltTag('"def"')}`)).toBe('"def"');
    expect(unsaltIfNoneMatch(saltTag('W/"abc"'))).toBe('W/"abc"');
  });

  test("a value that is not a quoted tag is left as it is", () => {
    expect(saltTag("*")).toBe("*");
    expect(saltTag("")).toBe("");
  });

  test("the lead's mask off: the phone's tag reaches the member as it was sent", async () => {
    const { transport, seen } = member(null, 304);
    const res = await viaLead("/api/pane/w1:p1/chat", transport, { mask: undefined, headers: { "if-none-match": ETAG } });
    expect(seen.headers.get("if-none-match")).toBe(ETAG);
    expect(res.headers.get("etag")).toBe(ETAG);
  });

  test("a picture's tag is never salted: the lead does not read it", async () => {
    const { transport, seen } = member(new Uint8Array([1, 2, 3]), 200, "image/png");
    const res = await viaLead("/api/pane/w1:p1/files/image?path=a.png", transport, {
      mask: maskForwardedAnswer,
      headers: { "if-none-match": ETAG },
    });
    expect(seen.headers.get("if-none-match")).toBe(ETAG);
    expect(res.headers.get("etag")).toBe(ETAG);
  });
});
