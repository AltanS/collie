// The browser leg's model stub (M67, ADR 0125): the cassette format, the matcher, the tier rule, the
// redaction check and the stub server. No network beyond 127.0.0.1: the "OpenRouter" here is a local
// fake that counts its hits, so a replay can prove it never called out.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  compactResponse,
  digestOf,
  forbiddenIn,
  formatCassette,
  matchSide,
  matchTurn,
  matchTurnAcross,
  normalizeText,
  parseCassette,
  placeholdersFor,
  redactKeys,
  replaceAcross,
  rewriteResponse,
  summarize,
  valuesFor,
  volatileValues,
  type Entry,
  type LegMeta,
  type RecordedResponse,
} from "./replay/cassette";
import { asJsonObject, asJsonString, parseJson } from "../../src/lib/json";
import { checkCassettes, checkFile } from "./replay/check";
import { costLines } from "./replay/report";
import { MISMATCH_STATUS, NO_CASE, dropRecording, startStub, upstreamUrl, type Stub } from "./replay/stub";
import { decideTier, modelFor, planTiers, readTierAsk, skillHash, type TierPlan, type TierPlans } from "./replay/tier";

const LAB = "/tmp/collie-lab-test/state";
const LITERALS = [[LAB, "{{lab}}"]] as const;
const FAKE_KEY = `sk-or-v1-${"a1b2c3d4".repeat(6)}`;

// ── request bodies as pi (Anthropic messages) and omp (Responses) send them ─────────────────────

function piBody(prompt: string, tail: "none" | "tool" = "none"): string {
  const messages: unknown[] = [{ role: "user", content: [{ type: "text", text: prompt }] }];
  if (tail === "tool") {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_1", name: "bash", input: { command: "ls" } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "a.txt" }] });
  }
  return JSON.stringify({ model: "anthropic/claude-haiku-4.5", stream: true, system: "you are pi", tools: [{ name: "read" }, { name: "bash" }], messages });
}

function ompBody(prompt: string): string {
  return JSON.stringify({ model: "anthropic/claude-haiku-4.5", stream: true, prompt_cache_key: "session-xyz", tools: [{ type: "function", name: "bash" }], input: [{ role: "user", content: [{ type: "input_text", text: prompt }] }] });
}

const WALKY_A = "[walky-talky wt_abcdefghij12 from local/w1:p3#ab12] Reply with one line, then run `collie walky reply wt_abcdefghij12 ok`. Sent 2026-10-26T09:00:00Z.";
const WALKY_B = "[walky-talky wt_zyxwvutsrq98 from local/w2:p1#cd34] Reply with one line, then run `collie walky reply wt_zyxwvutsrq98 ok`. Sent 2026-10-27T10:11:12Z.";

function sse(...datas: string[]): RecordedResponse {
  return { status: 200, contentType: "text/event-stream", events: datas.map((data, i) => ({ ms: i === 0 ? 30 : 20, event: "content_block_delta", data })) };
}

const delta = (text: string): string => JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
/** The text of one `delta()` event's data. */
const deltaText = (data: string): string => asJsonString(asJsonObject(asJsonObject(parseJson(data))?.delta)?.text) ?? "";

function entry(kind: "turn" | "side", ordinal: number, body: string, response: RecordedResponse, machine = "lead"): Entry {
  const summary = summarize("/api/v1/messages", body, LITERALS);
  return { kind, machine, ordinal, request: { ...summary, path: "/api/v1/messages", digest: digestOf(summary) }, response };
}

// ── cassette.ts ────────────────────────────────────────────────────────────────────────────────

describe("normalizeText", () => {
  it("turns every volatile value into its class and the lab folder into its placeholder", () => {
    const text = `${WALKY_A} cwd ${LAB}/harness/pi/project, bridge 127.0.0.1:18723, id 0f8fad5b-d9cb-469f-a165-70867728950e at 09:41:07`;
    expect(normalizeText(text, LITERALS)).toBe(
      "[walky-talky <walky> from <address>] Reply with one line, then run `collie walky reply <walky> ok`. Sent <time>. cwd {{lab}}/harness/pi/project, bridge <port>, id <uuid> at <clock>",
    );
  });

  it("leaves a path with `local` in it alone: /usr/local/bin is not a pane", () => {
    expect(normalizeText("PATH=/usr/local/bin:/opt/local/x")).toBe("PATH=/usr/local/bin:/opt/local/x");
  });

  it("gives two walky messages that differ only in ids and times the same digest", () => {
    expect(digestOf(summarize("/api/v1/messages", piBody(WALKY_A)))).toBe(digestOf(summarize("/api/v1/messages", piBody(WALKY_B))));
    expect(digestOf(summarize("/api/v1/messages", piBody(WALKY_A)))).not.toBe(digestOf(summarize("/api/v1/messages", piBody("Reply with exactly DONE-1"))));
  });
});

describe("summarize", () => {
  it("reads pi's Anthropic body: tools sorted, the last prompt, and the tail after it", () => {
    const s = summarize("/api/v1/messages?beta=true", piBody("list the files", "tool"));
    expect(s).toEqual({ api: "anthropic", model: "anthropic/claude-haiku-4.5", stream: true, tools: ["bash", "read"], prompt: "list the files", tail: ["call:bash", "result"] });
  });

  it("reads omp's Responses body and ignores its session key", () => {
    const a = summarize("/api/v1/responses", ompBody("hi"));
    expect(a).toMatchObject({ api: "responses", tools: ["bash"], prompt: "hi", tail: [] });
    const b = summarize("/api/v1/responses", ompBody("hi").replace("session-xyz", "session-other"));
    expect(digestOf(b)).toBe(digestOf(a));
  });

  it("calls a request with no tools a side request", () => {
    const s = summarize("/api/v1/messages", JSON.stringify({ model: "m", messages: [{ role: "user", content: "Title this chat" }] }));
    expect(s.tools).toEqual([]);
  });
});

describe("volatile values in a recorded answer", () => {
  it("records the walky id as a placeholder and replays the live request's id in its place", () => {
    const recorded = sse(delta("Running collie walky reply wt_abcd"), delta("efghij12 ok"));
    const stored = rewriteResponse(recorded, placeholdersFor(volatileValues(piBody(WALKY_A)), LITERALS));
    expect(stored.events?.map((e) => e.data).join("")).toContain("{{walky:0}}");
    expect(JSON.stringify(stored)).not.toContain("wt_abcdefghij12");
    const replayed = rewriteResponse(stored, valuesFor(volatileValues(piBody(WALKY_B)), LITERALS));
    const text = (replayed.events ?? []).map((e) => deltaText(e.data)).join("");
    expect(text).toBe("Running collie walky reply wt_zyxwvutsrq98 ok");
  });

  it("ranks values by their last place in the request: 0 is the most recent", () => {
    const values = volatileValues("first wt_aaaaaaaaaaaa then wt_bbbbbbbbbbbb then wt_aaaaaaaaaaaa again");
    expect(values.get("walky")).toEqual(["wt_aaaaaaaaaaaa", "wt_bbbbbbbbbbbb"]);
  });

  it("moves a part boundary that falls inside a replaced value to its end", () => {
    expect(replaceAcross(["say wt_ab", "cdefghij12 now"], [["wt_abcdefghij12", "X"]])).toEqual(["say X", " now"]);
    expect(replaceAcross(["no hit", " here"], [["wt_abcdefghij12", "X"]])).toEqual(["no hit", " here"]);
  });

  it("puts the lab folder back in on replay", () => {
    const stored = rewriteResponse(sse(delta(`cat ${LAB}/a.txt`)), placeholdersFor(new Map(), LITERALS));
    expect(stored.events?.[0]?.data).toContain("{{lab}}/a.txt");
    const other = [["/tmp/other/state", "{{lab}}"]] as const;
    expect(rewriteResponse(stored, valuesFor(new Map(), other)).events?.[0]?.data).toContain("/tmp/other/state/a.txt");
  });
});

describe("matchTurn", () => {
  const a = entry("turn", 0, piBody("first"), sse(delta("one")));
  const b = entry("turn", 1, piBody("second"), sse(delta("two")));
  const entries = [a, b];

  it("serves the first unused turn whose digest matches, so a harmless reorder still matches", () => {
    const hit = matchTurn(entries, "lead", summarize("/api/v1/messages", piBody("second")), new Set(), "pi.x");
    expect("entry" in hit && hit.index).toBe(1);
  });

  it("fails a changed prompt as a cassette mismatch that says to re-record, never a nearby answer", () => {
    const miss = matchTurn(entries, "lead", summarize("/api/v1/messages", piBody("a changed prompt")), new Set(), "pi.x");
    expect("mismatch" in miss && miss.mismatch).toMatch(/^cassette mismatch: case pi\.x turn 0 expected prompt "first".*re-record/u);
  });

  it("fails a request with no turn left, and a case with no cassette", () => {
    const used = new Set([0, 1]);
    expect("mismatch" in matchTurn(entries, "lead", summarize("/api/v1/messages", piBody("first")), used, "pi.x")).toBe(true);
    const none = matchTurn(undefined, "lead", summarize("/api/v1/messages", piBody("first")), new Set(), "pi.y");
    expect("mismatch" in none && none.mismatch).toContain("no cassette for case pi.y");
  });

  it("keeps the two machines of the crew leg apart", () => {
    expect("mismatch" in matchTurn(entries, "member", summarize("/api/v1/messages", piBody("first")), new Set(), "pi.x")).toBe(true);
  });

  it("borrows the same request from another case when it crossed a case boundary", () => {
    const byCase = new Map([
      ["pi.x", [a]],
      ["pi.y", [b]],
    ]);
    const hit = matchTurnAcross(byCase, "pi.x", "lead", summarize("/api/v1/messages", piBody("second")), () => new Set());
    expect("entry" in hit && hit.caseId).toBe("pi.y");
    const miss = matchTurnAcross(byCase, "pi.x", "lead", summarize("/api/v1/messages", piBody("third")), () => new Set());
    expect("mismatch" in miss).toBe(true);
  });

  it("matches a side request by digest alone, from the pool", () => {
    const side = entry("side", 0, JSON.stringify({ model: "m", messages: [{ role: "user", content: "Title: hello" }] }), sse(delta("Hello")));
    expect(matchSide([side], summarize("/api/v1/messages", JSON.stringify({ model: "m", messages: [{ role: "user", content: "Title: hello" }] })))).toBe(side);
    expect(matchSide([side], summarize("/api/v1/messages", JSON.stringify({ model: "m", messages: [{ role: "user", content: "Title: other" }] })))).toBeNull();
  });
});

describe("compactResponse", () => {
  it("drops the request's instructions and tools that a Responses stream echoes, and keeps the output", () => {
    const created = JSON.stringify({ type: "response.created", response: { id: "r1", instructions: "the whole system prompt", tools: [{ name: "bash" }], output: [] } });
    const text = JSON.stringify({ type: "response.output_text.delta", delta: "hi" });
    const out = compactResponse({ status: 200, contentType: "text/event-stream", events: [{ ms: 5, data: created }, { ms: 1, data: text }, { ms: 0, data: "[DONE]" }] });
    expect(out.events?.map((e) => e.data)).toEqual([JSON.stringify({ type: "response.created", response: { id: "r1", instructions: null, tools: [], output: [] } }), text, "[DONE]"]);
    expect(out.events?.[0]?.ms).toBe(5);
  });
});

describe("files and redaction", () => {
  it("writes and reads a cassette line for line", () => {
    const cassette = { header: { v: 1 as const, harness: "pi", version: "1.3.0", case: "pi.x", leg: "solo", recordedAt: "2026-10-26T00:00:00Z" }, entries: [entry("turn", 0, piBody("hi"), sse(delta("hello")))] };
    expect(parseCassette(formatCassette(cassette))).toEqual(cassette);
  });

  it("blanks a key the model echoes, and the check finds keys, bearer tokens, auth headers and home paths", () => {
    const redacted = redactKeys(sse(delta(`your key is ${FAKE_KEY}`), delta("Bearer abcdefghijklmnop")));
    expect(JSON.stringify(redacted)).not.toContain(FAKE_KEY);
    expect(forbiddenIn(JSON.stringify(redacted))).toEqual([]);
    expect(forbiddenIn(`{"x":"${FAKE_KEY}"}`)).toEqual(["line 1: an OpenRouter key"]);
    expect(forbiddenIn('ok\n{"authorization": "x"}')).toEqual(["line 2: an Authorization header"]);
    expect(forbiddenIn("cd /var/home/someone/projects")).toEqual(["line 1: a home folder path"]);
  });
});

// ── tier.ts ───────────────────────────────────────────────────────────────────────────────────

describe("decideTier", () => {
  const meta = { v: 1 as const, harness: "pi", version: "1.3.0", legs: { solo: { model: "m", skill: "s1", recordedAt: "t", cases: ["pi.x"] } } };
  const askOf = (env: Record<string, string>) => readTierAsk(env);

  it("replays when the cassettes hold this version, model and skill, and loads no key for it", () => {
    expect(decideTier("pi", "1.3.0", "solo", meta, "m", "s1", askOf({ COLLIE_RIG_KEY_FILE: "/k" }))).toMatchObject({ tier: "replay", record: false });
  });

  it("runs live and records on a version miss, so the next run replays", () => {
    expect(decideTier("pi", "1.4.0", "solo", null, "m", "s1", askOf({ COLLIE_RIG_KEY_FILE: "/k" }))).toMatchObject({ tier: "live", record: true, reason: "no cassettes for pi 1.4.0 (solo leg): live, recording" });
  });

  it("calls a new skill text or another model a miss too", () => {
    expect(decideTier("pi", "1.3.0", "solo", meta, "m", "s2", askOf({ COLLIE_RIG_KEY_FILE: "/k" })).tier).toBe("live");
    expect(decideTier("pi", "1.3.0", "solo", meta, "other", "s1", askOf({ COLLIE_RIG_KEY_FILE: "/k" })).tier).toBe("live");
    expect(decideTier("pi", "1.3.0", "crew", meta, "m", "s1", askOf({ COLLIE_RIG_KEY_FILE: "/k" })).tier).toBe("live");
  });

  it("records nothing without a key file, and never under a version it could not read", () => {
    expect(decideTier("pi", "1.4.0", "solo", null, "m", "s1", askOf({}))).toMatchObject({ tier: "live", record: false });
    expect(decideTier("pi", null, "solo", null, "m", "s1", askOf({ COLLIE_RIG_KEY_FILE: "/k" }))).toMatchObject({ tier: "live", record: false });
  });

  it("forces live with COLLIE_RIG_LIVE or COLLIE_RIG_MODEL=live, and records then only when asked", () => {
    expect(decideTier("pi", "1.3.0", "solo", meta, "m", "s1", askOf({ COLLIE_RIG_LIVE: "pi", COLLIE_RIG_KEY_FILE: "/k" }))).toMatchObject({ tier: "live", record: false });
    // COLLIE_RIG_LIVE=pi leaves omp on the rule: its cassettes cover it, so it replays.
    expect(decideTier("omp", "1.3.0", "solo", meta, "m", "s1", askOf({ COLLIE_RIG_LIVE: "pi" })).tier).toBe("replay");
    expect(decideTier("pi", "1.3.0", "solo", meta, "m", "s1", askOf({ COLLIE_RIG_LIVE: "all", COLLIE_RIG_RECORD: "1", COLLIE_RIG_KEY_FILE: "/k" }))).toMatchObject({ tier: "live", record: true });
    expect(decideTier("pi", "1.3.0", "solo", meta, "m", "s1", askOf({ COLLIE_RIG_MODEL: "live" })).tier).toBe("live");
  });

  it("replays a leg with cases recorded in a run where they did not pass, and names them", () => {
    const marked = { ...meta, legs: { solo: { ...meta.legs.solo, failed: ["pi.walky-agents"] } } };
    expect(decideTier("pi", "1.3.0", "solo", marked, "m", "s1", askOf({}))).toMatchObject({ tier: "replay", failed: ["pi.walky-agents"], reason: "cassettes pi/1.3.0 (solo leg); 1 recorded in a case that did not pass: pi.walky-agents" });
  });

  it("stops before the run with COLLIE_RIG_MODEL=replay when a cassette is missing", () => {
    expect(() => decideTier("pi", "1.4.0", "solo", null, "m", "s1", askOf({ COLLIE_RIG_MODEL: "replay" }))).toThrow(/COLLIE_RIG_MODEL=replay: no cassettes for pi 1\.4\.0/u);
    expect(() => readTierAsk({ COLLIE_RIG_MODEL: "replay", COLLIE_RIG_LIVE: "pi" })).toThrow(/opposite/u);
    expect(() => readTierAsk({ COLLIE_RIG_LIVE: "claude" })).toThrow(/pi, omp or all/u);
  });
});

describe("planTiers", () => {
  /** A cassette root holding pi 1.3.0 for the given legs only; omp has no folder at all. */
  const rootWith = (legs: readonly string[]): string => {
    const root = mkdtempSync(join(tmpdir(), "m67-plan-"));
    roots.push(root);
    mkdirSync(join(root, "pi", "1.3.0"), { recursive: true });
    const meta = { v: 1, harness: "pi", version: "1.3.0", legs: Object.fromEntries(legs.map((leg) => [leg, { model: modelFor("pi", {}), skill: skillHash(), recordedAt: "t", cases: [] }])) };
    writeFileSync(join(root, "pi", "1.3.0", "meta.json"), JSON.stringify(meta));
    return root;
  };
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const versions = { pi: "1.3.0", omp: "18.6.1" };

  it("plans the crew leg for pi only: omp does not run there, so it needs no cassette and has no tier", () => {
    const plans = planTiers("crew", { COLLIE_RIG_MODEL: "replay" }, versions, rootWith(["crew"]));
    expect(plans.pi).toMatchObject({ tier: "replay", leg: "crew", version: "1.3.0" });
    expect(plans.omp).toBeUndefined();
    expect(Object.keys(plans)).toEqual(["pi"]);
  });

  it("still throws on the solo leg for a missing omp cassette under replay, and records under live", () => {
    const root = rootWith(["solo"]);
    expect(() => planTiers("solo", { COLLIE_RIG_MODEL: "replay" }, versions, root)).toThrow(/no cassettes for omp 18\.6\.1 \(solo leg\)/u);
    const plans = planTiers("solo", { COLLIE_RIG_KEY_FILE: "/k" }, versions, root);
    expect(plans.pi).toMatchObject({ tier: "replay" });
    expect(plans.omp).toMatchObject({ tier: "live", record: true });
  });
});

// ── report.ts, check.ts ───────────────────────────────────────────────────────────────────────

const plan = (harness: "pi" | "omp", tier: "replay" | "live", record = false): TierPlan => ({ harness, leg: "solo", version: harness === "pi" ? "1.3.0" : "18.6.1", tier, record, reason: "r", model: "m", skill: "s" });

describe("costLines", () => {
  it("says a replay run sent nothing to OpenRouter", () => {
    const counts = (tier: string, replayed: number) => ({ tier, replayed, proxied: 0, recorded: 0, mismatches: 0 });
    const lines = costLines({ tiers: { pi: plan("pi", "replay"), omp: plan("omp", "replay") }, stub: { upstream: 0, harnesses: { pi: counts("replay", 14), omp: counts("replay", 9) }, mismatches: [], written: [] }, turns: { claude: 17, pi: 11, omp: 9 } });
    expect(lines).toEqual([
      "model: pi 1.3.0: replay (r), 14 model calls replayed",
      "model: omp 18.6.1: replay (r), 9 model calls replayed",
      "live model turns: claude 17 (subscription)",
      "OpenRouter requests this run: 0 (no provider key was loaded for a replayed harness)",
    ]);
  });

  it("prints no line for a harness the leg does not run", () => {
    const lines = costLines({ tiers: { pi: plan("pi", "replay") }, stub: { upstream: 0, harnesses: { pi: { tier: "replay", replayed: 3, proxied: 0, recorded: 0, mismatches: 0 } }, mismatches: [], written: [] }, turns: { claude: 2 } });
    expect(lines.filter((l) => l.startsWith("model:"))).toEqual(["model: pi 1.3.0: replay (r), 3 model calls replayed"]);
  });

  it("counts a live harness's turns and calls", () => {
    const lines = costLines({ tiers: { pi: plan("pi", "live", true), omp: plan("omp", "replay") }, stub: { upstream: 12, harnesses: { pi: { tier: "live", replayed: 0, proxied: 12, recorded: 12, mismatches: 0 } }, mismatches: [], written: [] }, turns: { claude: 3, pi: 11 } });
    expect(lines[0]).toBe("model: pi 1.3.0: live + record (r), 12 model calls to OpenRouter, 12 recorded");
    expect(lines.at(-2)).toBe("live model turns: claude 3 (subscription), pi 11");
  });
});

describe("checkCassettes", () => {
  it("passes a clean tree and names the file and line of a finding, never the text", () => {
    const root = mkdtempSync(join(tmpdir(), "m67-check-"));
    try {
      mkdirSync(join(root, "pi", "1.3.0"), { recursive: true });
      writeFileSync(join(root, "pi", "1.3.0", "pi.x.jsonl"), formatCassette({ header: { v: 1, harness: "pi", version: "1.3.0", case: "pi.x", leg: "solo", recordedAt: "t" }, entries: [] }));
      expect(checkCassettes(root)).toEqual([]);
      writeFileSync(join(root, "pi", "1.3.0", "pi.y.jsonl"), `{"v":1}\n{"leak":"${FAKE_KEY}"}\n`);
      const findings = checkCassettes(root);
      expect(findings).toEqual([join("pi", "1.3.0", "pi.y.jsonl") + ": line 2: an OpenRouter key"]);
      expect(findings.join("")).not.toContain(FAKE_KEY);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("checkFile", () => {
  const head = '{"v":1,"harness":"pi","version":"1.3.0","case":"pi.x","leg":"solo","recordedAt":"t"}\n';
  const check = (path: string, text: string): string[] => checkFile(path, text);
  const meta = (failed: string[] | undefined): string => {
    const base = { model: "m", skill: "s", recordedAt: "t", cases: ["pi.a", "pi.b"] };
    const leg: LegMeta = failed === undefined ? base : { ...base, failed };
    return JSON.stringify({ v: 1, harness: "pi", version: "1.3.0", legs: { solo: leg } });
  };

  it("passes a clean cassette and a clean meta, and the recorder's placeholders", () => {
    expect(check("pi/1.3.0/pi.x.jsonl", `${head}{"text":"cd {{lab}}/work and {{home}}/x, reply {{walky:0}} at <time>"}\n`)).toEqual([]);
    expect(check("pi/1.3.0/meta.json", meta(undefined))).toEqual([]);
  });

  it("fails every case listed under failed, in any leg, and names the file and the case", () => {
    expect(check("pi/1.3.0/meta.json", meta(["pi.b"]))).toEqual(["pi/1.3.0/meta.json: leg solo: pi.b is marked failed (re-record it alone, a merged tree holds none)"]);
    expect(check("pi/1.3.0/meta.json", "{")).toHaveLength(1);
  });

  it("fails a key pattern from 8 characters, and a bearer token from 8 non-space characters", () => {
    expect(check("a.jsonl", `${head}{"k":"sk-or-v1-abcd1234"}\n`)).toEqual(["a.jsonl: line 2: an OpenRouter key"]);
    expect(check("a.jsonl", `${head}{"k":"sk-or-v1-abc"}\n`)).toEqual([]);
    expect(check("a.jsonl", `${head}{"h":"Bearer x.y-z_12345"}\n`)).toEqual(["a.jsonl: line 2: a bearer token"]);
    expect(check("a.jsonl", `${head}{"h":"Bearer short"}\n`)).toEqual([]);
  });

  it("fails a home path of the owner, with /var/home or /home and a user name", () => {
    expect(check("a.jsonl", `${head}{"p":"/var/home/someone/x"}\n`)).toEqual(["a.jsonl: line 2: a home folder path"]);
    expect(check("a.jsonl", `${head}{"p":"/home/someone/x"}\n`)).toEqual(["a.jsonl: line 2: a home folder path"]);
    expect(check("a.jsonl", `${head}{"p":"/usr/local/home"}\n`)).toEqual([]);
  });

  it("fails the host and company names, in any letter case", () => {
    expect(check("a.jsonl", `${head}{"h":"bluefin"}\n{"h":"MiniBuch"}\n{"h":"x.sprqvntrs.com"}\n{"h":"Sportsight"}\n`)).toEqual([
      "a.jsonl: line 2: the host name bluefin",
      "a.jsonl: line 3: the host name minibuch",
      "a.jsonl: line 4: the name sprqvntrs",
      "a.jsonl: line 5: the name sportsight",
    ]);
  });

  it("fails a .jsonl over 1 MiB and keeps the existing checks", () => {
    const big = `${head}{"pad":"${"x".repeat(1024 * 1024)}"}\n`;
    expect(check("a.jsonl", big)).toEqual(["a.jsonl: 1025 KiB is over the 1024 KiB limit"]);
    expect(check("a.jsonl", `${head}{"pad":"${"x".repeat(1024 * 1024 - head.length - 20)}"}\n`)).toEqual([]);
    expect(check("a.jsonl", "not json\n")).toHaveLength(1);
    expect(check("a.jsonl", `${head}{"a":"Authorization: x"}\n`)).toEqual(["a.jsonl: line 2: an Authorization header"]);
  });
});

// ── stub.ts: a real listener, against a fake OpenRouter ──────────────────────────────────────

interface Fake {
  readonly server: Server;
  readonly origin: string;
  readonly hits: { path: string; auth: string | undefined }[];
}

/** A local stand-in for OpenRouter: streams three events 40 ms apart, echoing the walky id it was sent. */
async function fakeOpenRouter(): Promise<Fake> {
  const hits: Fake["hits"] = [];
  const server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      hits.push({ path: req.url ?? "", auth: req.headers.authorization });
      const id = /wt_[a-z0-9]{12}/u.exec(body)?.[0] ?? "none";
      res.writeHead(200, { "content-type": "text/event-stream" });
      const events = [delta(`reply ${id.slice(0, 6)}`), delta(`${id.slice(6)} ok`), delta(` (key ${FAKE_KEY})`)];
      let i = 0;
      const tick = () => {
        const next = events[i++];
        if (next === undefined) {
          res.end("event: message_stop\ndata: {\"type\":\"message_stop\"}\n\n");
          return;
        }
        res.write(`event: content_block_delta\ndata: ${next}\n\n`);
        setTimeout(tick, 40);
      };
      setTimeout(tick, 40);
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
  // SAFETY: a TCP listener's address() is an AddressInfo once `listen` has called back.
  const { port } = server.address() as AddressInfo;
  return { server, origin: `http://127.0.0.1:${String(port)}`, hits };
}

/** One model request to the stub, as pi sends it. */
async function ask(stub: Stub, body: string, path = "/pi-lead/api/v1/messages"): Promise<{ status: number; text: string; ms: number }> {
  const started = Date.now();
  const res = await fetch(`http://127.0.0.1:${String(stub.port)}${path}`, { method: "POST", headers: { authorization: `Bearer ${FAKE_KEY}`, "content-type": "application/json" }, body });
  const text = await res.text();
  return { status: res.status, text, ms: Date.now() - started };
}

const replayedText = (sseText: string): string =>
  sseText
    .split("\n")
    .filter((line) => line.startsWith("data: ") && line.includes("text_delta"))
    .map((line) => deltaText(line.slice(6)))
    .join("");

describe("the stub", () => {
  const cleanups: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanups.splice(0).toReversed()) await fn();
  });

  async function setup(): Promise<{ root: string; fake: Fake }> {
    const root = mkdtempSync(join(tmpdir(), "m67-stub-"));
    const fake = await fakeOpenRouter();
    cleanups.push(() => rmSync(root, { recursive: true, force: true }));
    cleanups.push(() => new Promise<void>((done) => fake.server.close(() => done())));
    return { root, fake };
  }

  const plans = (pi: TierPlan): TierPlans => ({ pi, omp: plan("omp", "live") });

  async function stubOn(root: string, fake: Fake, pi: TierPlan, speed = 1): Promise<Stub> {
    const stub = await startStub({ root, leg: "solo", plans: plans(pi), literals: [...LITERALS], upstream: fake.origin, speed });
    cleanups.push(() => stub.close());
    return stub;
  }

  it("maps the harness's path onto OpenRouter's", () => {
    expect(upstreamUrl("https://openrouter.ai", "/api/v1/messages")).toBe("https://openrouter.ai/api/v1/messages");
    expect(upstreamUrl("https://openrouter.ai", "/api/v1/responses")).toBe("https://openrouter.ai/api/v1/responses");
  });

  it("records a live stream with no header and no key, then replays it with the next run's ids and zero upstream calls", async () => {
    const { root, fake } = await setup();
    const live = await stubOn(root, fake, plan("pi", "live", true));
    live.setCase("pi.walky-reply");
    const first = await ask(live, piBody(WALKY_A));
    expect(first.status).toBe(200);
    expect(replayedText(first.text)).toBe(`reply wt_abcdefghij12 ok (key ${FAKE_KEY})`);
    expect(fake.hits).toEqual([{ path: "/api/v1/messages", auth: `Bearer ${FAKE_KEY}` }]);
    expect(live.stats()).toMatchObject({ upstream: 1, harnesses: { pi: { proxied: 1, recorded: 1 } } });
    await live.close();

    const dir = join(root, "pi", "1.3.0");
    expect(readdirSync(dir).toSorted()).toEqual(["meta.json", "pi.walky-reply.jsonl"]);
    const file = readFileSync(join(dir, "pi.walky-reply.jsonl"), "utf8");
    expect(forbiddenIn(file)).toEqual([]);
    expect(file).not.toMatch(/authorization|wt_abcdefghij12/iu);
    expect(file).toContain("{{walky:0}}");
    expect(JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"))).toMatchObject({ harness: "pi", version: "1.3.0", legs: { solo: { model: "m", skill: "s", cases: ["pi.walky-reply"] } } });

    const replay = await stubOn(root, fake, plan("pi", "replay"));
    replay.setCase("pi.walky-reply");
    const again = await ask(replay, piBody(WALKY_B));
    expect(again.status).toBe(200);
    expect(replayedText(again.text)).toBe("reply wt_zyxwvutsrq98 ok (key [redacted key])");
    expect(again.text).toContain("message_stop");
    // The recorded pacing: four gaps of about 40 ms. Never faster than recorded at speed 1.
    expect(again.ms).toBeGreaterThanOrEqual(120);
    expect(fake.hits).toHaveLength(1);
    expect(replay.stats()).toMatchObject({ upstream: 0, harnesses: { pi: { replayed: 1, proxied: 0 } }, mismatches: [] });
  });

  it("answers a changed prompt with HTTP 422 `cassette mismatch` and counts it, never a canned answer", async () => {
    const { root, fake } = await setup();
    const live = await stubOn(root, fake, plan("pi", "live", true));
    live.setCase("pi.walky-reply");
    await ask(live, piBody(WALKY_A));
    await live.close();

    const replay = await stubOn(root, fake, plan("pi", "replay"));
    replay.setCase("pi.walky-reply");
    const miss = await ask(replay, piBody("a prompt the leg never recorded"));
    expect(miss.status).toBe(MISMATCH_STATUS);
    expect(miss.text).toContain("cassette_mismatch");
    expect(miss.text).toContain("re-record");
    expect(replay.stats().mismatches).toEqual([expect.objectContaining({ harness: "pi", machine: "lead", case: "pi.walky-reply", kind: "turn" })]);
    expect(replay.stats().harnesses.pi?.mismatches).toBe(1);
    expect(fake.hits).toHaveLength(1);
  });

  it("compresses the pacing with a speed, and files a request before the first case under its own id", async () => {
    const { root, fake } = await setup();
    const live = await stubOn(root, fake, plan("pi", "live", true));
    await ask(live, piBody(WALKY_A));
    await live.close();
    expect(readdirSync(join(root, "pi", "1.3.0"))).toContain(`${NO_CASE}.jsonl`);

    const fast = await stubOn(root, fake, plan("pi", "replay"), 20);
    const quick = await ask(fast, piBody(WALKY_B));
    expect(quick.status).toBe(200);
    expect(quick.ms).toBeLessThan(120);
  });

  it("marks a case recorded in a run where it did not pass, and clears the mark when it passes again", async () => {
    const { root, fake } = await setup();
    const verdict = (stub: Stub, c: string, v: string) => fetch(`http://127.0.0.1:${String(stub.port)}/_rig/verdict`, { method: "POST", body: JSON.stringify({ case: c, verdict: v }) });
    // SAFETY: meta.json is the stub's own JSON.stringify of a CassetteMeta (stub.ts writeMeta).
    const meta = () => JSON.parse(readFileSync(join(root, "pi", "1.3.0", "meta.json"), "utf8")).legs.solo as { cases: string[]; failed?: string[] };
    const first = await stubOn(root, fake, plan("pi", "live", true));
    for (const c of ["pi.a", "pi.b"]) {
      first.setCase(c);
      await ask(first, piBody(`prompt ${c}`));
    }
    await verdict(first, "pi.a", "fail");
    await verdict(first, "pi.b", "pass");
    await verdict(first, "pi.never-recorded", "fail");
    await first.close();
    expect(meta()).toMatchObject({ cases: ["pi.a", "pi.b"], failed: ["pi.a"] });

    const again = await stubOn(root, fake, plan("pi", "live", true));
    again.setCase("pi.a");
    await ask(again, piBody("prompt pi.a"));
    await verdict(again, "pi.a", "pass");
    await again.close();
    expect(meta().cases).toEqual(["pi.a", "pi.b"]);
    expect(meta().failed).toBeUndefined();
  });

  describe("the life-cycle of a recording", () => {
    const post = (stub: Stub, c: string, v: string) => fetch(`http://127.0.0.1:${String(stub.port)}/_rig/verdict`, { method: "POST", body: JSON.stringify({ case: c, verdict: v }) });
    const dirOf = (root: string) => join(root, "pi", "1.3.0");
    // SAFETY: meta.json is the stub's own JSON.stringify of a CassetteMeta (stub.ts writeMeta).
    const legOf = (root: string) => JSON.parse(readFileSync(join(dirOf(root), "meta.json"), "utf8")).legs.solo as { cases: string[]; failed?: string[]; recordedAt: string };
    const treeOf = (root: string): Record<string, string> => Object.fromEntries(readdirSync(dirOf(root)).map((name) => [name, readFileSync(join(dirOf(root), name), "utf8")]));
    const logged: string[] = [];

    /** A record run of pi: each case asks once (or not at all) and gets its verdict; the stub is closed after. */
    async function recordRun(root: string, fake: Fake, cases: Record<string, { prompt: string | null; verdict: string }>, tier: "live" | "replay" = "live"): Promise<void> {
      const stub = await startStub({ root, leg: "solo", plans: plans(plan("pi", tier, tier === "live")), literals: [...LITERALS], upstream: fake.origin, log: (line) => logged.push(line) });
      for (const [c, { prompt, verdict }] of Object.entries(cases)) {
        stub.setCase(c);
        if (prompt !== null) await ask(stub, piBody(prompt));
        await post(stub, c, verdict);
      }
      await stub.close();
    }

    it("removes the file and the meta entries of a case that passes with no model call", async () => {
      const { root, fake } = await setup();
      await recordRun(root, fake, { "pi.a": { prompt: "first a", verdict: "fail" }, "pi.b": { prompt: "first b", verdict: "pass" } });
      expect(legOf(root)).toMatchObject({ cases: ["pi.a", "pi.b"], failed: ["pi.a"] });
      const stamp = legOf(root).recordedAt;
      logged.length = 0;
      await recordRun(root, fake, { "pi.a": { prompt: null, verdict: "pass" } });
      expect(readdirSync(dirOf(root)).toSorted()).toEqual(["meta.json", "pi.b.jsonl"]);
      expect(legOf(root)).toMatchObject({ cases: ["pi.b"], recordedAt: stamp });
      expect(legOf(root).failed).toBeUndefined();
      expect(logged.filter((l) => l.includes("pi.a"))).toEqual(["pi pi.a: passed with no model call, recording removed"]);
      // A case that was never recorded changes nothing, and a case that fails with no call is left alone.
      const before = treeOf(root);
      await recordRun(root, fake, { "pi.never": { prompt: null, verdict: "pass" }, "pi.b": { prompt: null, verdict: "fail" } });
      expect(treeOf(root)).toEqual(before);
    });

    it("drops a case by hand the same way (dropRecording), and only that case", async () => {
      const { root, fake } = await setup();
      await recordRun(root, fake, { "pi.a": { prompt: "first a", verdict: "fail" }, "pi.b": { prompt: "first b", verdict: "fail" } });
      expect(dropRecording(root, "solo", "pi", "1.3.0", "pi.a")).toBe(true);
      expect(dropRecording(root, "solo", "pi", "1.3.0", "pi.a")).toBe(false);
      expect(readdirSync(dirOf(root)).toSorted()).toEqual(["meta.json", "pi.b.jsonl"]);
      expect(legOf(root)).toMatchObject({ cases: ["pi.b"], failed: ["pi.b"] });
    });

    it("overwrites the file and clears the mark when a case passes with calls", async () => {
      const { root, fake } = await setup();
      await recordRun(root, fake, { "pi.a": { prompt: "first a", verdict: "fail" } });
      const first = treeOf(root)["pi.a.jsonl"];
      await recordRun(root, fake, { "pi.a": { prompt: "second a", verdict: "pass" } });
      expect(treeOf(root)["pi.a.jsonl"]).not.toBe(first);
      expect(treeOf(root)["pi.a.jsonl"]).toContain("second a");
      expect(legOf(root).cases).toEqual(["pi.a"]);
      expect(legOf(root).failed).toBeUndefined();
    });

    it("keeps a good recording when the case fails once, leaves meta as it was, and says so in one line", async () => {
      const { root, fake } = await setup();
      await recordRun(root, fake, { "pi.a": { prompt: "good a", verdict: "pass" }, "pi.b": { prompt: "good b", verdict: "pass" } });
      const before = treeOf(root);
      logged.length = 0;
      await new Promise((done) => setTimeout(done, 5));
      await recordRun(root, fake, { "pi.a": { prompt: "flaky a", verdict: "fail" } });
      expect(treeOf(root)).toEqual(before);
      expect(logged.filter((l) => l.includes("kept"))).toEqual(["pi pi.a: failed live (fail), the earlier recording was not marked failed, kept"]);
      expect(logged.some((l) => l.includes("recorded in a case that did not pass"))).toBe(false);
    });

    it("writes and marks the new recording when the case fails and there is none, or the old one is already marked", async () => {
      const { root, fake } = await setup();
      await recordRun(root, fake, { "pi.a": { prompt: "bad a", verdict: "fail" } });
      expect(legOf(root)).toMatchObject({ cases: ["pi.a"], failed: ["pi.a"] });
      await recordRun(root, fake, { "pi.a": { prompt: "worse a", verdict: "fail" } });
      expect(treeOf(root)["pi.a.jsonl"]).toContain("worse a");
      expect(legOf(root)).toMatchObject({ cases: ["pi.a"], failed: ["pi.a"] });
    });

    it("changes no cassette and no meta on a replay run, whatever the verdicts", async () => {
      const { root, fake } = await setup();
      await recordRun(root, fake, { "pi.a": { prompt: "good a", verdict: "pass" }, "pi.b": { prompt: "bad b", verdict: "fail" } });
      const before = treeOf(root);
      await new Promise((done) => setTimeout(done, 5));
      await recordRun(root, fake, { "pi.a": { prompt: null, verdict: "pass" }, "pi.b": { prompt: null, verdict: "fail" }, "pi.c": { prompt: null, verdict: "fail" } }, "replay");
      expect(treeOf(root)).toEqual(before);
    });
  });

  it("answers a catalog read with 503 and an unknown path with 404, on every tier, without calling out", async () => {
    const { root, fake } = await setup();
    const stub = await stubOn(root, fake, plan("pi", "live", true));
    expect((await fetch(`http://127.0.0.1:${String(stub.port)}/omp-lead/api/v1/models`)).status).toBe(503);
    expect((await fetch(`http://127.0.0.1:${String(stub.port)}/elsewhere`)).status).toBe(404);
    expect(fake.hits).toHaveLength(0);
    expect(stub.stats().upstream).toBe(0);
  });
});
