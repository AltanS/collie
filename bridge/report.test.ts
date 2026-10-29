// Report a problem (ADR 0123): the screen a report carries, and `GET /api/report/context`. The handler
// inside Bun.serve only gates and resolves the session; `reportContextRoute` is everything after it.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendsReportRows } from "../cli/send-findings.ts";
import { realFiles } from "../cli/sys.ts";
import type { SendReceipt } from "../web/src/lib/surface/send.ts";
import { muxOk, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "./mux/types.ts";
import { MASK } from "./redact.ts";
import { REPORT_SCREEN_ROWS, reportScreen, type DoctorRowSource } from "./report.ts";
import { HoldStore } from "./surface/holds.ts";
import { RequestStore } from "./surface/requests.ts";
import { reportContextRoute, type ReportMachine, type ReportRouteRuntime } from "./server.ts";

// Placeholders only, never a real key. Joined at runtime so a secret scan of this file finds nothing.
const OPENROUTER = `sk-or-v1-your-key-here-${"0".repeat(40)}`;
const GITHUB = ["ghp_", "placeholder0000000000000000000000"].join("");
const ESC = String.fromCharCode(27);

// The edge reads the platform from HOST; the route only passes it on.
const MACHINE: ReportMachine = { collie: "1.24.1+abc1234", line: "edge", os: "linux", arch: "x64" };

/** A fake session runtime and the grid reads it was asked for. */
interface FakeRuntime {
  readonly rt: ReportRouteRuntime;
  readonly reads: MuxGridRequest[];
}

type FakeMux = { -readonly [K in keyof ReportRouteRuntime["herdr"]]: ReportRouteRuntime["herdr"][K] };

function runtime(screen: string, program = false): FakeRuntime {
  const reads: MuxGridRequest[] = [];
  const herdr: FakeMux = {
    mux: "herdr",
    readGrid: async (paneId: string, request: MuxGridRequest): Promise<MuxOutcome<MuxGrid>> => {
      reads.push(request);
      return muxOk({ paneId, text: screen, truncated: false, revision: 7 });
    },
  };
  // A program session takes guarded controls and has no screen (ADR 0101): the method's presence says so.
  if (program) {
    herdr.controlTurn = async () => {
      throw new Error("a report never drives a turn");
    };
  }
  const engine: ReportRouteRuntime["engine"] = {
    current: () => ({ agents: [{ paneId: "%1", agent: "claude" }], shellPanes: [{ paneId: "%2" }] }),
    noteInput: () => {},
    pokeNow: () => {},
  };
  return { rt: { engine, herdr }, reads };
}

describe("reportScreen", () => {
  test("keeps the last rows, cuts trailing blanks and blank rows at the bottom", () => {
    const rows = Array.from({ length: 60 }, (_, n) => `row ${String(n)}   `);
    const out = reportScreen([...rows, "", "  "].join("\n"));
    const lines = out.split("\n");
    expect(lines).toHaveLength(REPORT_SCREEN_ROWS);
    expect(lines[0]).toBe("row 20");
    expect(lines.at(-1)).toBe("row 59");
  });

  test("masks a secret shape whatever COLLIE_REDACT says", () => {
    const out = reportScreen(`$ env\nOPENROUTER_API_KEY=${OPENROUTER}\ntoken ${GITHUB}\n❯ `);
    expect(out).not.toContain(OPENROUTER);
    expect(out).not.toContain(GITHUB);
    expect(out).toContain(MASK);
    expect(out.split("\n")[0]).toBe("$ env");
  });
});

describe("reportContextRoute (ADR 0123)", () => {
  test("answers the machine's half with no pane, and no screen", async () => {
    const { rt, reads } = runtime("x");
    const res = await reportContextRoute(rt, null, false, MACHINE, null);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ collie: "1.24.1+abc1234", line: "edge", os: "linux", arch: "x64", mux: "herdr", harness: null, screenable: false });
    expect(reads).toEqual([]);
  });

  test("names the pane's agent, and a bare shell as an empty string", async () => {
    const { rt } = runtime("x");
    expect((await (await reportContextRoute(rt, "%1", false, MACHINE, null)).json()).harness).toBe("claude");
    const shell = await (await reportContextRoute(rt, "%2", false, MACHINE, null)).json();
    expect(shell).toMatchObject({ harness: "", screenable: true });
    expect(shell.screen).toBeUndefined();
  });

  test("refuses a pane this session does not show, and a bad pane id", async () => {
    const { rt, reads } = runtime("x");
    const res = await reportContextRoute(rt, "%9", true, MACHINE, null);
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("no such pane");
    expect((await reportContextRoute(rt, "", false, MACHINE, null)).status).toBe(400);
    expect((await reportContextRoute(rt, "p".repeat(257), false, MACHINE, null)).status).toBe(400);
    expect(reads).toEqual([]);
  });

  test("on screen=1 returns the pane's last rows, escapes stripped and every secret masked", async () => {
    const screen = `${ESC}[1mclaude${ESC}[0m ready\nexport KEY=${OPENROUTER}\n${ESC}[2m${GITHUB}${ESC}[0m\n> `;
    const { rt, reads } = runtime(screen);
    const res = await reportContextRoute(rt, "%1", true, MACHINE, null);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.screen).not.toContain(OPENROUTER);
    expect(body.screen).not.toContain(GITHUB);
    expect(body.screen).not.toContain(ESC);
    expect(body.screen.split("\n")[0]).toBe("claude ready");
    expect(body.screen).toContain(MASK);
    // The mirror's own read shape, which leaves the operator's screen where it is.
    expect(reads).toEqual([{ scope: "recent", lines: REPORT_SCREEN_ROWS, styling: "preserve" }]);
  });

  test("the setup block names facts about the machine and the pane, and no file path of a program a send read", async () => {
    const { rt } = runtime("claude ready");
    const body = await (await reportContextRoute(rt, "%1", false, MACHINE, null)).json();
    // The set of keys is the whole contract: a receipt's `binary` (an absolute local path) is not among them.
    expect(Object.keys(body).toSorted()).toEqual(["arch", "collie", "harness", "line", "mux", "os", "screenable"]);
    expect(JSON.stringify(body)).not.toMatch(/\/(?:home|Users|root)\b/u);
  });

  test("a program session has no screen: screenable is false and screen=1 is a 400", async () => {
    const { rt, reads } = runtime("x", true);
    expect((await (await reportContextRoute(rt, "%1", false, MACHINE, null)).json()).screenable).toBe(false);
    expect((await reportContextRoute(rt, "%1", true, MACHINE, null)).status).toBe(400);
    expect(reads).toEqual([]);
  });

  test("the browser asks a paired device for it (device-read), and a crew member's pane is refused (by source)", () => {
    const code = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    const at = code.indexOf('pathname === "/api/report/context"');
    expect(at).toBeGreaterThan(0);
    const block = code.slice(at, at + 600);
    expect(block).toContain('browserGate("device-read")');
    expect(block).toContain('host.kind === "member"');
  });
});

// ── The doctor's send rows (M71 spec 05) ─────────────────────────────────────

const NOW = 1_800_000_000_000;
const MINUTE = 60_000;
const HELD_TEXT = "the-held-text-fixture-plugh";
const TYPED_TEXT = "the-typed-text-fixture-xyzzy";

function receipt(id: string, harness: string, outcome: SendReceipt["outcome"], reason?: SendReceipt["reason"]): SendReceipt {
  const base: SendReceipt = {
    requestId: id, session: "main", paneId: "%1", paneGeneration: "g1", harness, version: "1.0.0", profileId: harness,
    profileStatus: "verified", textHash: "0".repeat(64), textLength: 5, s0: null, s1: null, s2: null, gapsMs: {}, keys: [], outcome,
  };
  return reason === undefined ? base : { ...base, reason };
}

let stateDir = "";
afterEach(() => {
  if (stateDir !== "") rmSync(stateDir, { recursive: true, force: true });
  stateDir = "";
});

/**
 * A real state dir as the bridge's own stores write it: three claude sends that met a screen Collie
 * could not type into, two codex sends that went through, and one claude send held 12 minutes, its
 * text in the held file in plain form.
 */
function stateWithSends(): string {
  stateDir = mkdtempSync(join(tmpdir(), "collie-report-doctor-"));
  const sends = new RequestStore(join(stateDir, "sends"), () => NOW - MINUTE);
  const send = (n: number, harness: string, outcome: SendReceipt["outcome"], reason?: SendReceipt["reason"]): void => {
    const id = `req-${String(n).padStart(4, "0")}-abcdef`;
    sends.accept({ id, session: "main", paneId: "%1", paneGeneration: "g1", surfaceRevision: 1, mode: "send", text: TYPED_TEXT });
    sends.settle(id, receipt(id, harness, outcome, reason));
  };
  for (let n = 0; n < 3; n++) send(n, "claude", "refused", "probe_failed");
  send(3, "codex", "sent");
  send(4, "codex", "sent");
  const held = new HoldStore(join(stateDir, "held"), () => NOW - 12 * MINUTE);
  held.add({ id: "req-h000-abcdef", session: "main", paneId: "%1", harness: "claude", mode: "send", text: HELD_TEXT, revision: 1, command: false, cause: "turn_running" });
  return stateDir;
}

/** The machine with the reader index.ts wires: the doctor's own sends section over the state dir. */
function machineOver(dir: string): ReportMachine {
  return { ...MACHINE, sendHealth: () => sendsReportRows({ ctx: { stateDir: dir }, files: realFiles, now: () => NOW }) };
}

describe("reportContextRoute: the doctor's send rows (M71 spec 05)", () => {
  test("with a pane, only the rows of the pane's harness, in the doctor's order", async () => {
    const { rt } = runtime("x");
    const body = await (await reportContextRoute(rt, "%1", false, machineOver(stateWithSends()), null)).json();
    expect(body.doctor.map((row: { check: string }) => row.check)).toEqual(["sends-claude", "holds-claude", "screen-claude"]);
    expect(body.doctor[0]).toEqual({ check: "sends-claude", status: "warn", detail: "3 refused (probe_failed 3) · last 7 days", harness: "claude" });
    expect(body.doctor[2]).toMatchObject({ check: "screen-claude", status: "warn", harness: "claude" });
  });

  test("a bare shell is the doctor's `-` group, and a harness with no rows answers an empty list", async () => {
    const { rt } = runtime("x");
    const shell = await (await reportContextRoute(rt, "%2", false, machineOver(stateWithSends()), null)).json();
    expect(shell.doctor).toEqual([]);
    const rows: DoctorRowSource[] = [
      { check: "sends--", status: "ok", detail: "1 sent · last 7 days", harness: "-", quiet: false },
      { check: "sends-claude", status: "ok", detail: "1 sent · last 7 days", harness: "claude", quiet: false },
    ];
    const answer = await (await reportContextRoute(rt, "%2", false, { ...MACHINE, sendHealth: () => rows }, null)).json();
    expect(answer.doctor.map((row: { check: string }) => row.check)).toEqual(["sends--"]);
  });

  test("with no pane, every row that says more than nothing here, and never the no-holds row", async () => {
    const { rt } = runtime("x");
    const body = await (await reportContextRoute(rt, null, false, machineOver(stateWithSends()), null)).json();
    expect(body.doctor.map((row: { check: string }) => row.check)).toEqual(["sends-claude", "sends-codex", "holds-claude", "screen-claude"]);
    // A quiet state: every sends row says no sends, the holds row says none are open. Nothing is carried.
    stateDir = mkdtempSync(join(tmpdir(), "collie-report-doctor-"));
    const empty = await (await reportContextRoute(rt, null, false, machineOver(stateDir), null)).json();
    expect(empty.doctor).toEqual([]);
    const withPane = await (await reportContextRoute(rt, "%1", false, machineOver(stateDir), null)).json();
    expect(withPane.doctor).toEqual([{ check: "sends-claude", status: "ok", detail: "no sends in the last 7 days", harness: "claude" }]);
  });

  test("a held text, a typed text and a remedy never appear in the answer", async () => {
    const { rt } = runtime("x");
    const dir = stateWithSends();
    for (const pane of ["%1", null]) {
      const raw = await (await reportContextRoute(rt, pane, false, machineOver(dir), null)).text();
      expect(raw).not.toContain(HELD_TEXT);
      expect(raw).not.toContain(TYPED_TEXT);
      expect(raw).not.toContain("remedy");
      expect(raw).not.toContain("Report a problem");
      for (const row of JSON.parse(raw).doctor) expect(Object.keys(row).toSorted()).toEqual(["check", "detail", "harness", "status"]);
    }
  });

  test("a row is copied field by field: a source row's extra fields stay behind", async () => {
    const { rt } = runtime("x");
    // SAFETY: a source row with fields the type does not name, which is what a looser reader could hand over; the route must drop them.
    const leaky = { check: "holds-claude", status: "warn", detail: "held 12 min", harness: "claude", quiet: false, remedy: "advice", text: HELD_TEXT } as DoctorRowSource;
    const body = await (await reportContextRoute(rt, "%1", false, { ...MACHINE, sendHealth: () => [leaky] }, null)).json();
    expect(body.doctor).toEqual([{ check: "holds-claude", status: "warn", detail: "held 12 min", harness: "claude" }]);
  });

  test("a throwing reader leaves the field out and the route still answers 200, with the screen too", async () => {
    const { rt } = runtime("claude ready");
    const machine: ReportMachine = { ...MACHINE, sendHealth: () => { throw new Error("EACCES"); } };
    const res = await reportContextRoute(rt, "%1", false, machine, null);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.doctor).toBeUndefined();
    expect(body.harness).toBe("claude");
    const screen = await reportContextRoute(rt, "%1", true, machine, null);
    expect(screen.status).toBe(200);
    expect((await screen.json()).screen).toBe("claude ready");
  });

  test("the rows ride with the screen on screen=1", async () => {
    const { rt } = runtime("claude ready");
    const body = await (await reportContextRoute(rt, "%1", true, machineOver(stateWithSends()), null)).json();
    expect(body.screen).toBe("claude ready");
    expect(body.doctor).toHaveLength(3);
  });

  test("the edge passes the reader from the options and server.ts imports no cli/ module (by source)", () => {
    const code = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
    expect(code).not.toMatch(/^import \{[^}]*\} from "\.\.\/cli\//mu);
    const at = code.indexOf('pathname === "/api/report/context"');
    expect(code.slice(at, at + 900)).toContain("sendHealth: opts.sendHealth");
    const index = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    expect(index).toContain("sendHealth: cfg.sendProtocol ? () => sendsReportRows({ ctx: { stateDir: cfg.stateDir }, files: realFiles, now: Date.now }) : undefined");
  });
});
