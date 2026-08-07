import { describe, expect, test } from "bun:test";

import { computeEtag, gzipJsonResponse, notModified } from "./http-cache.ts";

// All three helpers are pure (no I/O), so we drive them directly.

describe("computeEtag", () => {
  test("returns a quoted hex string", () => {
    const etag = computeEtag("hello");
    expect(etag).toMatch(/^"[0-9a-f]+"$/);
  });

  test("same text → same etag (stability)", () => {
    const text = "some pane output\nanother line\x1b[32mgreen\x1b[0m";
    expect(computeEtag(text)).toBe(computeEtag(text));
  });

  test("different text → different etag", () => {
    expect(computeEtag("text a")).not.toBe(computeEtag("text b"));
  });

  test("empty string produces a valid etag", () => {
    expect(computeEtag("")).toMatch(/^"[0-9a-f]+"$/);
  });
});

describe("notModified", () => {
  test("returns true when If-None-Match matches the etag", () => {
    const etag = computeEtag("response body");
    expect(notModified(etag, etag)).toBe(true);
  });

  test("returns false when If-None-Match differs", () => {
    expect(notModified('"oldvalue"', '"newvalue"')).toBe(false);
  });

  test("returns false when If-None-Match is null (no header)", () => {
    expect(notModified(null, '"abc123"')).toBe(false);
  });

  test("is strict — partial prefix does not match", () => {
    const etag = '"abcdef"';
    expect(notModified('"abc"', etag)).toBe(false);
  });
});

// The host dimension in a merged snapshot's cache key (PACK_PROTOCOL.md §4, §9.2): a pane id is only
// unique per machine, so the same pane id on two different hosts must never collapse into one ETag —
// or a phone that just 304'd against "desk" could be served stale/wrong content when it's really
// asking about "laptop". Pure computeEtag/body-bytes test — no server.ts, no Bun.serve.
describe("computeEtag — the host dimension", () => {
  const pane = (host: string) => ({
    paneId: "w1:p1",
    workspaceId: "w1",
    workspaceLabel: "w1",
    workspaceNumber: 1,
    tabId: "w1:t1",
    agent: "claude",
    status: "idle",
    cwd: "/home/you/demo",
    focused: false,
    kind: "agent",
    host,
  });

  test("two snapshot-shaped bodies identical except a pane's host differ in etag", () => {
    const bodyDesk = JSON.stringify({ agents: [pane("desk")], shellPanes: [], ts: 0 });
    const bodyLaptop = JSON.stringify({ agents: [pane("laptop")], shellPanes: [], ts: 0 });
    expect(computeEtag(bodyDesk)).not.toBe(computeEtag(bodyLaptop));
  });

  test("the same pane id + session on two hosts, merged into one body, is two distinct entries", () => {
    // What a lead would actually emit: both panes present at once, keyed apart only by host.
    const merged = {
      agents: [
        { ...pane("desk"), sessionName: undefined },
        { ...pane("laptop"), sessionName: undefined },
      ],
      shellPanes: [],
      ts: 0,
    };
    // Same pane id on both entries — proves the collapse risk is real if host were ignored.
    expect(merged.agents[0]!.paneId).toBe(merged.agents[1]!.paneId);

    const serialized = JSON.stringify(merged);
    // A body that collapsed the two hosts would serialize identically to one with only one entry
    // repeated; assert the two entries actually carry distinct host values in the emitted bytes.
    const parsed = JSON.parse(serialized) as { agents: Array<{ paneId: string; host: string }> };
    expect(parsed.agents).toHaveLength(2);
    expect(new Set(parsed.agents.map((a) => a.host)).size).toBe(2);

    // And the resulting etag differs from a body that (incorrectly) omitted host from one entry —
    // i.e. host bytes are actually inside what gets hashed, not merely present in the JS object.
    const collapsedLikeBody = JSON.stringify({
      agents: [pane("desk"), { ...pane("desk"), host: "desk" }],
      shellPanes: [],
      ts: 0,
    });
    expect(computeEtag(serialized)).not.toBe(computeEtag(collapsedLikeBody));
  });
});

describe("gzipJsonResponse", () => {
  test("returns plain JSON when Accept-Encoding does not include gzip", async () => {
    const data = { ok: true, value: "x".repeat(300) };
    const res = gzipJsonResponse(data, "br, identity");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    const parsed = await res.json();
    expect(parsed).toEqual(data);
  });

  test("returns plain JSON when Accept-Encoding is null", async () => {
    const data = { ok: true, value: "x".repeat(300) };
    const res = gzipJsonResponse(data, null);
    expect(res.headers.get("content-encoding")).toBeNull();
    const parsed = await res.json();
    expect(parsed).toEqual(data);
  });

  test("returns plain JSON when body is below the compression threshold (< 256 bytes)", async () => {
    // A small body like {ok:true} is only a handful of bytes — no point compressing.
    const data = { ok: true };
    const res = gzipJsonResponse(data, "gzip");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(await res.json()).toEqual(data);
  });

  test("gzips large bodies when Accept-Encoding includes gzip", async () => {
    const data = { text: "x".repeat(300) }; // well above 256-byte threshold
    const res = gzipJsonResponse(data, "gzip, deflate");
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("vary")).toBe("accept-encoding");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("content-type")).toContain("application/json");

    // Round-trip: decompress and verify the original JSON is intact.
    const buf = await res.arrayBuffer();
    const decompressed = Bun.gunzipSync(new Uint8Array(buf));
    const text = new TextDecoder().decode(decompressed);
    expect(JSON.parse(text)).toEqual(data);
  });

  test("merges extraHeaders into the response", () => {
    const res = gzipJsonResponse({ ok: true }, null, { etag: '"abc123"' });
    expect(res.headers.get("etag")).toBe('"abc123"');
    // Standard headers still present alongside the extra one.
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  test("extraHeaders etag is present on a compressed response too", async () => {
    const data = { text: "x".repeat(300) };
    const etag = '"deadbeef"';
    const res = gzipJsonResponse(data, "gzip", { etag });
    expect(res.headers.get("content-encoding")).toBe("gzip");
    expect(res.headers.get("etag")).toBe(etag);
  });
});
