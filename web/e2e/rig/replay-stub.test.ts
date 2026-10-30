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
  matchKeyOf,
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
import { asJsonObject, asJsonString, parseJson, type JsonObject } from "../../src/lib/json";
import { checkCassettes, checkFile } from "./replay/check";
import { costLines } from "./replay/report";
import { MISMATCH_STATUS, NO_CASE, dropRecording, startStub, upstreamUrl, type Stub } from "./replay/stub";
import { dashed, decideTier, modelFor, planTiers, readTierAsk, rigLiterals, skillHash, type TierPlan, type TierPlans } from "./replay/tier";

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

/**
 * A request body as Claude Code 2.1.312 sends it (probed 2026-10-29, M67 spec 07): the memory and
 * context reminders before the prompt, `role: system` items, cache-control fields, a billing line.
 */
function claudeBody(prompt: string, opts: { lab?: string; tail?: "none" | "tool"; tool?: string; email?: string; memory?: string; billing?: string } = {}): string {
  const lab = opts.lab ?? LAB;
  const project = `${lab}/harness/claude/project`;
  const reminder = (text: string) => ({ type: "text", text: `<system-reminder>\n${text}\n</system-reminder>\n` });
  const messages: unknown[] = [
    {
      role: "user",
      content: [
        reminder(`Codebase and user instructions are shown below. Be sure to adhere to these instructions.\n\nContents of /home/someone/.claude/CLAUDE.md (project instructions, checked into the codebase):\n\n${opts.memory ?? "Run everything on bluefin."}\n\nContents of ${lab}/harness/claude/config/CLAUDE.md (user's private global instructions for all projects):\n\nThis session runs inside Collie's automated browser test.`),
        reminder(`As you answer the user's questions, you can use the following context:\n# userEmail\nThe user's email address is ${opts.email ?? "me@sportsight.example"}.\n# currentDate\nToday's date is 2026-10-29.`),
        { type: "text", text: prompt, cache_control: { type: "ephemeral", ttl: "1h" } },
      ],
    },
    { role: "system", content: `# Environment\n - Primary working directory: ${project}\n - OS Version: Linux 7.2.5-200.fc44.x86_64\n - Scratchpad directory: /tmp/claude-1000/${dashed(project)}/a0534cbe-5225-424b-8207-2ae50557dd1c/scratchpad` },
  ];
  if (opts.tail === "tool") {
    messages.push({ role: "assistant", content: [{ type: "tool_use", id: "toolu_01", name: "Bash", input: { command: "touch phone-ran.txt" } }] });
    messages.push({ role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_01", content: "(Bash completed with no output)" }] });
  }
  messages.push({ role: "system", content: [{ type: "text", text: "<total_tokens>14999983 tokens left</total_tokens>", cache_control: { type: "ephemeral" } }] });
  return JSON.stringify({
    model: "claude-haiku-5-5",
    stream: true,
    max_tokens: 128000,
    metadata: { user_id: JSON.stringify({ device_id: "d1", account_uuid: "19d75529-0b4c-4e00-bd9a-b5b4caaca1f8", session_id: "a0534cbe-5225-424b-8207-2ae50557dd1c" }) },
    system: [
      { type: "text", text: `x-anthropic-billing-header: cc_version=2.1.312.${opts.billing ?? "237"}; cc_entrypoint=cli;` },
      { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: { type: "ephemeral", ttl: "1h" } },
      { type: "text", text: `You have a persistent memory at \`${lab}/harness/claude/config/projects/${dashed(project)}/memory/\`.`, cache_control: { type: "ephemeral", ttl: "1h" } },
    ],
    tools: [
      { name: "Bash", description: "Run a shell command.", input_schema: { type: "object", properties: { command: { type: "string" } } } },
      { name: opts.tool ?? "Read", description: "Read a file.", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } },
    ],
    messages,
  });
}

/** The literals of a rig whose state root is `lab`, with a fixed home (rigLiterals). */
const claudeLiterals = (lab: string) => rigLiterals(lab, "/home/someone");

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

  it("masks a walky case's mark (the id's characters 3 to 9) as volatile as its id, in the prompt and in an answer", () => {
    const a = `[walky-talky wt_k5bosk123456 from operator] Walky dialog check k5bosk: answer with only the word ZEBRA-NINE.`;
    const b = `[walky-talky wt_1r5257abcdef from operator] Walky dialog check 1r5257: answer with only the word ZEBRA-NINE.`;
    expect(normalizeText(a)).toBe("[walky-talky <walky> from operator] Walky dialog check <mark>: answer with only the word ZEBRA-NINE.");
    expect(normalizeText(b)).toBe(normalizeText(a));
    expect(volatileValues(a).get("mark")).toEqual(["k5bosk"]);
    const stored = rewriteResponse(sse(delta("saw k5bosk")), placeholdersFor(volatileValues(a), []));
    expect(stored.events?.[0]?.data).toContain("{{mark:0}}");
    expect(rewriteResponse(stored, valuesFor(volatileValues(b), [])).events?.[0]?.data).toContain("saw 1r5257");
    // Not a mark: the same six characters inside a longer word.
    expect(normalizeText("[walky-talky wt_k5bosk123456] xk5bosk")).toBe("[walky-talky <walky>] xk5bosk");
  });

  it("reads an address that starts a line of `collie walky who` in a raw body, where a JSON `\\n` comes before it", () => {
    const who = (member: string) =>
      JSON.stringify({ content: `ADDRESS                 MACHINE     HARNESS\nlocal/w1:p1#aaaa        rig-lead    claude  (you)\n${member}  rig-member  pi` });
    const a = who("rig-member/w2:p1#jva8");
    const b = who("rig-member/w2:p1#q7xd");
    expect(volatileValues(a).get("address")).toEqual([]);
    expect(volatileValues(a).get("lineaddress")).toEqual(["rig-member/w2:p1#jva8", "local/w1:p1#aaaa"]);
    const stored = rewriteResponse(sse(delta("collie walky send 'rig-member/w2:p1#jva8' hi")), placeholdersFor(volatileValues(a), []));
    expect(stored.events?.[0]?.data).toContain("{{lineaddress:0}}");
    expect(rewriteResponse(stored, valuesFor(volatileValues(b), [])).events?.[0]?.data).toContain("'rig-member/w2:p1#q7xd'");
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

describe("summarize, the anthropic vendor (Claude Code, spec 07)", () => {
  const read = (body: string, lab = LAB) => summarize("/v1/messages?beta=true", body, claudeLiterals(lab), "anthropic");

  it("keeps each reminder's first line and the rig's own memory file, never the operator's file or email", () => {
    const s = read(claudeBody("hello there"));
    expect(s.prompt).toContain("Codebase and user instructions are shown below.");
    expect(s.prompt).toContain("Contents of {{lab}}/harness/claude/config/CLAUDE.md");
    expect(s.prompt).toContain("This session runs inside Collie's automated browser test.");
    expect(s.prompt).toContain("As you answer the user's questions, you can use the following context:");
    expect(s.prompt).toMatch(/hello there$/u);
    expect(JSON.stringify(s)).not.toMatch(/bluefin|sportsight|someone\/\.claude|userEmail|OS Version/u);
    expect(forbiddenIn(JSON.stringify(s))).toEqual([]);
  });

  it("leaves Claude's role-system items out of the tail, and reads a tool call and its result", () => {
    expect(read(claudeBody("hello there")).tail).toEqual([]);
    expect(read(claudeBody("touch it", { tail: "tool" }))).toMatchObject({ prompt: expect.stringMatching(/touch it$/u), tail: ["call:Bash", "result"], tools: ["Bash", "Read"] });
  });

  it("gives the same digest under another state root, another email, another operator CLAUDE.md and another billing hash", () => {
    const a = read(claudeBody("hello there"));
    const b = read(claudeBody("hello there", { lab: "/tmp/other-root/state", email: "x@y.example", memory: "Something else.", billing: "c5f" }), "/tmp/other-root/state");
    expect(a.context).toMatch(/^[0-9a-f]{16}$/u);
    expect(b.context).toBe(a.context);
    expect(digestOf(b)).toBe(digestOf(a));
  });

  it("changes the context with a tool definition, so another tool list is a mismatch", () => {
    const a = read(claudeBody("hello there"));
    const b = read(claudeBody("hello there", { tool: "Write" }));
    expect(b.context).not.toBe(a.context);
    expect(digestOf(b)).not.toBe(digestOf(a));
  });

  it("keeps pi's and omp's summaries without a context, so their cassettes keep their digests", () => {
    expect(summarize("/api/v1/messages", piBody("hi")).context).toBeUndefined();
    expect("context" in summarize("/api/v1/responses", ompBody("hi"))).toBe(false);
  });

  it("masks this machine's own name, so a recording never carries it and both sides digest the same", () => {
    expect(rigLiterals("/tmp/x/state", "/home/someone", "runner7.tail1.example")).toEqual(expect.arrayContaining([["runner7", "{{host}}"]]));
    expect(rigLiterals("/tmp/x/state", "/home/someone", "localhost").some(([, p]) => p === "{{host}}")).toBe(false);
    // The skill text's example names (bluefin, minibuch) are masked on every machine, so the digest does not move with the host.
    expect(rigLiterals("/tmp/x/state", "/home/someone", "runner7")).toEqual(expect.arrayContaining([["bluefin", "{{skillhosta}}"], ["minibuch", "{{skillhostb}}"]]));
    const on = (host: string) => summarize("/v1/messages?beta=true", claudeBody(`example bluefin and minibuch, run on ${host}`), rigLiterals(LAB, "/home/someone", host), "anthropic");
    expect(digestOf(on("machine-two"))).toBe(digestOf(on("runner7")));
  });

  it("names the dashed forms of the rig's folders as literals", () => {
    expect(claudeLiterals("/tmp/x/state")).toEqual(expect.arrayContaining([["-tmp-x-state", "{{labdash}}"], ["-home-someone", "{{homedash}}"]]));
    expect(dashed("/var/home/a/.cache/collie-lab")).toBe("-var-home-a--cache-collie-lab");
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

  it("matches a turn with or without omp's session reminder, so a case's place in the run does not move its turns into the next case", () => {
    const reminder = "<system-reminder>\nToday: 2026-10-30T11:47:00Z; current working directory: '/tmp/lab'. Do not repeat this information in your reply.\n</system-reminder>\n";
    const first = entry("turn", 0, piBody(`${reminder}List fruits`), sse(delta("one")));
    const again = entry("turn", 1, piBody("List fruits"), sse(delta("two")));
    const later = entry("turn", 0, piBody("List fruits"), sse(delta("three")));
    const byCase = new Map([
      ["omp.queued", [first, again]],
      ["omp.busy", [later]],
    ]);
    const used = new Map<string, Set<number>>();
    const usedIn = (id: string): Set<number> => used.get(id) ?? used.set(id, new Set()).get(id) ?? new Set();
    for (const want of [0, 1]) {
      const hit = matchTurnAcross(byCase, "omp.queued", "lead", summarize("/api/v1/messages", piBody("List fruits")), usedIn);
      expect("entry" in hit && `${hit.caseId}:${String(hit.index)}`).toBe(`omp.queued:${String(want)}`);
      if ("entry" in hit) usedIn(hit.caseId).add(hit.index);
    }
    expect("entry" in matchTurn([first], "lead", summarize("/api/v1/messages", piBody("List fruits")), new Set(), "omp.queued")).toBe(true);
  });

  it("matches a Claude turn with or without the reminder blocks that lead a session's first message", () => {
    const full = claudeBody("Use walky talky.");
    // SAFETY: claudeBody above builds this JSON with exactly these message and content fields.
    const parsed = JSON.parse(full) as { messages: { role: string; content: unknown[] }[] };
    // The same request in a later message of the session: no reminder blocks in front of the prompt.
    const first = parsed.messages[0];
    if (first === undefined) throw new Error("no first message");
    first.content = first.content.slice(2);
    const make = (raw: string) => summarize("/v1/messages?beta=true", raw, claudeLiterals(LAB), "anthropic");
    expect(digestOf(make(full))).not.toBe(digestOf(make(JSON.stringify(parsed))));
    expect(matchKeyOf(make(full))).toBe(matchKeyOf(make(JSON.stringify(parsed))));
    expect(matchKeyOf(make(full))).not.toBe(matchKeyOf(make(claudeBody("Use walky talky now."))));
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
    expect(() => readTierAsk({ COLLIE_RIG_LIVE: "codex" })).toThrow(/pi, omp, claude or all/u);
  });
});

describe("decideTier for Claude (spec 07)", () => {
  const meta = { v: 1 as const, harness: "claude", version: "2.1.312", legs: { solo: { model: "haiku", skill: "s1", recordedAt: "t", cases: [] } } };
  it("records a version miss on its own login, with no key file", () => {
    expect(decideTier("claude", "2.1.313", "solo", null, "haiku", "s1", readTierAsk({}))).toMatchObject({ tier: "live", record: true });
    expect(decideTier("claude", "2.1.312", "solo", meta, "haiku", "s1", readTierAsk({}))).toMatchObject({ tier: "replay", record: false });
  });
  it("goes live with COLLIE_RIG_LIVE=claude or all, and records then only when asked", () => {
    expect(decideTier("claude", "2.1.312", "solo", meta, "haiku", "s1", readTierAsk({ COLLIE_RIG_LIVE: "claude" }))).toMatchObject({ tier: "live", record: false });
    expect(decideTier("claude", "2.1.312", "solo", meta, "haiku", "s1", readTierAsk({ COLLIE_RIG_LIVE: "all", COLLIE_RIG_RECORD: "1" }))).toMatchObject({ tier: "live", record: true });
    expect(decideTier("pi", "1.3.0", "solo", { ...meta, harness: "pi", version: "1.3.0" }, "haiku", "s1", readTierAsk({ COLLIE_RIG_LIVE: "claude" })).tier).toBe("replay");
  });
});

describe("planTiers", () => {
  /** A cassette root holding pi 1.3.0 and Claude 2.1.312 for the given legs only; omp has no folder at all. */
  const rootWith = (legs: readonly string[]): string => {
    const root = mkdtempSync(join(tmpdir(), "m67-plan-"));
    roots.push(root);
    for (const [harness, version] of [["pi", "1.3.0"], ["claude", "2.1.312"]] as const) {
      mkdirSync(join(root, harness, version), { recursive: true });
      const meta = { v: 1, harness, version, legs: Object.fromEntries(legs.map((leg) => [leg, { model: modelFor(harness, {}), skill: skillHash(), recordedAt: "t", cases: [] }])) };
      writeFileSync(join(root, harness, version, "meta.json"), JSON.stringify(meta));
    }
    return root;
  };
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });
  const versions = { pi: "1.3.0", omp: "18.6.1", claude: "2.1.312" };

  it("plans the crew leg for pi and Claude only: omp does not run there, so it needs no cassette and has no tier", () => {
    const plans = planTiers("crew", { COLLIE_RIG_MODEL: "replay" }, versions, rootWith(["crew"]));
    expect(plans.pi).toMatchObject({ tier: "replay", leg: "crew", version: "1.3.0" });
    expect(plans.omp).toBeUndefined();
    expect(Object.keys(plans)).toEqual(["pi", "claude"]);
    expect(plans.claude).toMatchObject({ tier: "replay", leg: "crew", version: "2.1.312", model: "haiku" });
  });

  it("still throws on the solo leg for a missing omp cassette under replay, and records under live", () => {
    const root = rootWith(["solo"]);
    expect(() => planTiers("solo", { COLLIE_RIG_MODEL: "replay" }, versions, root)).toThrow(/no cassettes for omp 18\.6\.1 \(solo leg\)/u);
    const plans = planTiers("solo", { COLLIE_RIG_KEY_FILE: "/k" }, versions, root);
    expect(plans.pi).toMatchObject({ tier: "replay" });
    expect(plans.omp).toMatchObject({ tier: "live", record: true });
    expect(plans.claude).toMatchObject({ tier: "replay" });
  });

  it("records a new Claude version live, and a Claude whose version cannot be read runs live and records nothing", () => {
    const root = rootWith(["solo"]);
    expect(planTiers("solo", {}, { ...versions, claude: "2.1.313" }, root).claude).toMatchObject({ tier: "live", record: true, reason: "no cassettes for claude 2.1.313 (solo leg): live, recording" });
    expect(planTiers("solo", {}, { ...versions, claude: null }, root).claude).toMatchObject({ tier: "live", record: false });
  });
});

// ── report.ts, check.ts ───────────────────────────────────────────────────────────────────────

const VERSION_OF = { pi: "1.3.0", omp: "18.6.1", claude: "2.1.312" } as const;
const plan = (harness: "pi" | "omp" | "claude", tier: "replay" | "live", record = false): TierPlan => ({ harness, leg: "solo", version: VERSION_OF[harness], tier, record, reason: "r", model: "m", skill: "s" });

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

  it("says a Claude replay spent no live turn and sent nothing to Anthropic", () => {
    const counts = (tier: string, replayed: number) => ({ tier, replayed, proxied: 0, recorded: 0, mismatches: 0 });
    const lines = costLines({ tiers: { pi: plan("pi", "replay"), omp: plan("omp", "replay"), claude: plan("claude", "replay") }, stub: { upstream: 0, harnesses: { pi: counts("replay", 14), omp: counts("replay", 9), claude: counts("replay", 40) }, mismatches: [], written: [] }, turns: { claude: 24, pi: 11, omp: 9 } });
    expect(lines).toEqual([
      "model: pi 1.3.0: replay (r), 14 model calls replayed",
      "model: omp 18.6.1: replay (r), 9 model calls replayed",
      "model: claude 2.1.312: replay (r), 40 model calls replayed",
      "live model turns: claude 0",
      "OpenRouter requests this run: 0 (no provider key was loaded for a replayed harness)",
      "Anthropic requests this run: 0 (Claude replayed on a dummy login)",
    ]);
  });

  it("counts a recording Claude's turns on the subscription and its calls to Anthropic", () => {
    const lines = costLines({ tiers: { pi: plan("pi", "replay"), claude: plan("claude", "live", true) }, stub: { upstream: 30, harnesses: { pi: { tier: "replay", replayed: 3, proxied: 0, recorded: 0, mismatches: 0 }, claude: { tier: "live", replayed: 0, proxied: 30, recorded: 30, mismatches: 0 } }, mismatches: [], written: [] }, turns: { claude: 24 } });
    expect(lines).toContain("model: claude 2.1.312: live + record (r), 30 model calls to Anthropic, 30 recorded");
    expect(lines).toContain("live model turns: claude 24 (subscription)");
    expect(lines.at(-2)).toBe("OpenRouter requests this run: 0");
    expect(lines.at(-1)).toBe("Anthropic requests this run: 30");
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

  describe("Claude Code (spec 07)", () => {
    const TOKEN = "sk-ant-oat01-REALTOKENREALTOKENREALTOKEN";
    /** One SSE event of the fake's stream, its data already JSON. */
    const ev = (event: string, data: JsonObject) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

    /** A local stand-in for Anthropic: a tool_use answer to a prompt, a text answer to a tool result. */
    async function fakeAnthropic(): Promise<Fake> {
      const hits: Fake["hits"] = [];
      const server = createServer((req: IncomingMessage, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf8");
          hits.push({ path: req.url ?? "", auth: req.headers.authorization });
          const result = body.includes("tool_result");
          const message = { id: "msg_01", type: "message", role: "assistant", model: "claude-haiku-5-5", content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } };
          const parts = [ev("message_start", { type: "message_start", message })];
          if (result) {
            parts.push(ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }), ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `done in ${LAB}/harness/claude/project` } }));
          } else {
            parts.push(
              ev("content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_01", name: "Bash", input: {} } }),
              ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: `{"command": "touch ${LAB}/harness/cla` } }),
              ev("content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: 'ude/project/phone-ran.txt"}' } }),
            );
          }
          parts.push(ev("content_block_stop", { type: "content_block_stop", index: 0 }), ev("message_delta", { type: "message_delta", delta: { stop_reason: result ? "end_turn" : "tool_use" } }), ev("message_stop", { type: "message_stop" }));
          res.writeHead(200, { "content-type": "text/event-stream" });
          let i = 0;
          const tick = () => {
            const next = parts[i++];
            if (next === undefined) return void res.end();
            res.write(next);
            setTimeout(tick, 15);
          };
          tick();
        });
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", () => done()));
      // SAFETY: a TCP listener's address() is an AddressInfo once `listen` has called back.
      const { port } = server.address() as AddressInfo;
      cleanups.push(() => new Promise<void>((done) => server.close(() => done())));
      return { server, origin: `http://127.0.0.1:${String(port)}`, hits };
    }

    async function claudeStub(root: string, anthropic: Fake, claude: TierPlan): Promise<Stub> {
      const stub = await startStub({ root, leg: "solo", plans: { claude }, literals: claudeLiterals(LAB), anthropic: anthropic.origin, upstream: "http://127.0.0.1:9" });
      cleanups.push(() => stub.close());
      return stub;
    }

    const send = async (stub: Stub, body: string, token: string) => {
      const res = await fetch(`http://127.0.0.1:${String(stub.port)}/claude-lead/v1/messages?beta=true`, { method: "POST", headers: { authorization: `Bearer ${token}`, "x-claude-code-session-id": "a0534cbe-5225-424b-8207-2ae50557dd1c", "anthropic-beta": "oauth-2025-04-20", "content-type": "application/json" }, body });
      return { status: res.status, text: await res.text() };
    };

    it("answers HEAD /api/hello with 200 on every tier, locally", async () => {
      const root = mkdtempSync(join(tmpdir(), "m67-claude-"));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const anthropic = await fakeAnthropic();
      for (const tier of ["replay", "live"] as const) {
        if (tier === "replay") {
          mkdirSync(join(root, "claude", "2.1.312"), { recursive: true });
          writeFileSync(join(root, "claude", "2.1.312", "meta.json"), JSON.stringify({ v: 1, harness: "claude", version: "2.1.312", legs: { solo: { model: "m", skill: "s", recordedAt: "t", cases: [] } } }));
        }
        const stub = await claudeStub(root, anthropic, plan("claude", tier, tier === "live"));
        expect((await fetch(`http://127.0.0.1:${String(stub.port)}/claude-lead/api/hello`, { method: "HEAD" })).status).toBe(200);
        await stub.close();
      }
      expect(anthropic.hits).toEqual([]);
    });

    it("records a tool-use turn and its tool-result turn with the token passed through and never stored, then replays both with no call out", async () => {
      const root = mkdtempSync(join(tmpdir(), "m67-claude-"));
      cleanups.push(() => rmSync(root, { recursive: true, force: true }));
      const anthropic = await fakeAnthropic();
      const live = await claudeStub(root, anthropic, plan("claude", "live", true));
      live.setCase("claude.permission");
      const call = await send(live, claudeBody("Run touch phone-ran.txt"), TOKEN);
      expect(call.status).toBe(200);
      expect(call.text).toContain("input_json_delta");
      const result = await send(live, claudeBody("Run touch phone-ran.txt", { tail: "tool" }), TOKEN);
      expect(result.text).toContain("done in");
      expect(anthropic.hits).toEqual([
        { path: "/v1/messages?beta=true", auth: `Bearer ${TOKEN}` },
        { path: "/v1/messages?beta=true", auth: `Bearer ${TOKEN}` },
      ]);
      expect(live.stats()).toMatchObject({ upstream: 2, harnesses: { claude: { proxied: 2, recorded: 2 } } });
      await live.close();

      const dir = join(root, "claude", "2.1.312");
      const file = readFileSync(join(dir, "claude.permission.jsonl"), "utf8");
      expect(file).not.toMatch(/REALTOKEN|authorization|a0534cbe|oauth-2025|sportsight|bluefin|19d75529/iu);
      expect(forbiddenIn(file)).toEqual([]);
      expect(checkFile("claude/2.1.312/claude.permission.jsonl", file)).toEqual([]);
      const entries = parseCassette(file).entries;
      expect(entries.map((e) => [e.kind, e.request.tail.join(" ")])).toEqual([
        ["turn", ""],
        ["turn", "call:Bash result"],
      ]);
      for (const e of entries) expect(e.request.context).toMatch(/^[0-9a-f]{16}$/u);
      expect(file).toContain("{{lab}}/harness/cla");

      // Replay under another state root: the folder comes back as this run's, the dummy token is never forwarded.
      const other = "/tmp/collie-lab-test/other";
      const replay = await startStub({ root, leg: "solo", plans: { claude: plan("claude", "replay") }, literals: claudeLiterals(other), anthropic: anthropic.origin });
      cleanups.push(() => replay.close());
      replay.setCase("claude.permission");
      const again = await send(replay, claudeBody("Run touch phone-ran.txt", { lab: other }), "collie-rig-replay-no-token");
      expect(again.status).toBe(200);
      const json = again.text
        .split("\n")
        .filter((line) => line.includes("partial_json"))
        .map((line) => asJsonString(asJsonObject(asJsonObject(parseJson(line.slice(6)))?.delta)?.partial_json) ?? "")
        .join("");
      expect(json).toBe(`{"command": "touch ${other}/harness/claude/project/phone-ran.txt"}`);
      const second = await send(replay, claudeBody("Run touch phone-ran.txt", { lab: other, tail: "tool" }), "collie-rig-replay-no-token");
      expect(second.text).toContain(`done in ${other}/harness/claude/project`);
      expect(anthropic.hits).toHaveLength(2);
      expect(replay.stats()).toMatchObject({ upstream: 0, harnesses: { claude: { replayed: 2, proxied: 0 } }, mismatches: [] });

      // A third request the recording never saw is a loud mismatch.
      const miss = await send(replay, claudeBody("something else", { lab: other }), "collie-rig-replay-no-token");
      expect(miss.status).toBe(MISMATCH_STATUS);
      expect(miss.text).toContain("cassette_mismatch");
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
