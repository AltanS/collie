import { readFileSync } from "node:fs";
import { join } from "node:path";

import { http, HttpResponse } from "msw";

import { server } from "@/test/setup";
import { fetchSnapshot } from "./api";
import { healthFor, hostHealthMap, writeRefusal } from "./host-health";
import { HOST_PARAM, normalizeSession, scopeSearch, SESSION_PARAM, sessionSearch } from "./session";
import type { SnapshotResponse } from "./types";

// ─────────────────────────────────────────────────────────────────────────────
// SOLO ZERO-TAX — the client half.
//
// The bridge half lives in `bridge/solo-baseline.test.ts` and owns the contract (CREW_PROTOCOL.md
// §11). This file answers what only the frontend can: a solo body carries none of the crew fields
// the mirror types allow, and a solo client puts NO host param on the wire — §11's `?h=` row:
// "never emitted by the client, never present in a URL".
//
// The golden snapshot is read from the BRIDGE's fixture on purpose: one committed body, both sides
// pinned to it.
// ─────────────────────────────────────────────────────────────────────────────

const GOLDEN = join(__dirname, "..", "..", "..", "bridge", "fixtures", "solo-baseline", "snapshot.json");
// SAFETY: the golden is the bridge's own committed solo body — `bridge/prompt-binding.test.ts`
// reads the same file and pins it from the other side, so its shape IS `SnapshotResponse`. The
// assertions below are what would fail if it ever stopped being.
const goldenSnapshot = JSON.parse(readFileSync(GOLDEN, "utf8")) as SnapshotResponse;

describe("solo zero-tax — a solo body carries no crew field", () => {
  it("the golden solo body carries NONE of the crew fields the types allow", () => {
    // `servers` and `host` exist on the mirror types, and every one is optional: a solo BODY has none
    // of them. This is the byte-level claim §11 makes.
    expect(goldenSnapshot).not.toHaveProperty("servers");
    for (const pane of [...goldenSnapshot.agents, ...goldenSnapshot.shellPanes]) {
      expect(pane).not.toHaveProperty("host");
    }
    for (const s of goldenSnapshot.sessions ?? []) {
      expect(s).not.toHaveProperty("host");
    }
  });
});

describe("solo zero-tax — a solo client puts no host on the wire", () => {
  it("the session param is `s`, and a solo scope emits no host param at all", () => {
    expect(SESSION_PARAM).toBe("s");
    expect(sessionSearch(undefined)).toBe("");
    expect(sessionSearch("collie-demo")).toBe("?s=collie-demo");
    expect(normalizeSession("")).toBeUndefined();
    // The host param EXISTS (the addressing dimension shipped), but a solo client never produces it:
    // no host means no `?h=`, so every URL a solo install builds is byte-identical to before.
    expect(HOST_PARAM).toBe("h");
    expect(scopeSearch({})).toBe("");
    expect(scopeSearch({ host: undefined, session: undefined })).toBe("");
    expect(scopeSearch({ session: "collie-demo" })).toBe("?s=collie-demo");
    expect(scopeSearch({ session: "collie-demo" })).toBe(sessionSearch("collie-demo"));
  });

  it("fetchSnapshot on a solo install requests a bare /api/snapshot — no query at all", async () => {
    const urls: string[] = [];
    server.use(
      http.get("/api/snapshot", ({ request }) => {
        urls.push(new URL(request.url).search);
        return HttpResponse.json(goldenSnapshot);
      }),
    );
    const snap = await fetchSnapshot();
    expect(urls).toEqual([""]);
    // Round-trips the bridge's golden body untouched.
    expect(snap).toEqual(goldenSnapshot);
  });

  it("a named session still only ever adds `session=` — never `h=` or `host=`", async () => {
    const urls: string[] = [];
    server.use(
      http.get("/api/snapshot", ({ request }) => {
        urls.push(new URL(request.url).search);
        return HttpResponse.json(goldenSnapshot);
      }),
    );
    await fetchSnapshot({ session: "collie-demo" });
    expect(urls).toEqual(["?session=collie-demo"]);
    expect(urls[0]).not.toMatch(/\b(h|host)=/);
  });
});

// TIER 2 (lead↔peer health) is the newest thing that could tax a solo install, because it is the
// first crew feature that DERIVES rather than merely labels — and a derivation that produces an
// entry for "here" would give a one-machine install a peer-health dimension it has no peers for.
describe("solo runs no per-host health machinery at all", () => {
  it("derives an empty health map from the golden solo snapshot", () => {
    // `servers` is optional-and-absent in the committed solo body (§11), which is the whole input.
    expect(goldenSnapshot.servers).toBeUndefined();
    const map = hostHealthMap(goldenSnapshot.servers, { at: goldenSnapshot.ts, pollMs: 1500 });
    expect(map.size).toBe(0);
  });

  it("answers 'nothing to say' for every lookup, so no surface can render host chrome or refuse a write", () => {
    const map = hostHealthMap(goldenSnapshot.servers, { at: goldenSnapshot.ts, pollMs: 1500 });
    // `undefined` (no host in hand) and a named host both answer the same on solo — there is no
    // host dimension to be wrong about, which is what makes the hide rule data rather than a flag.
    expect(healthFor(map, undefined)).toBeUndefined();
    expect(healthFor(map, "anything")).toBeUndefined();
    expect(writeRefusal(healthFor(map, "anything"))).toBeUndefined();
  });
});
