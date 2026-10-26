// Report a problem (ADR 0123): the screen a report carries, and `GET /api/report/context`. The handler
// inside Bun.serve only gates and resolves the session; `reportContextRoute` is everything after it.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { muxOk, type MuxGrid, type MuxGridRequest, type MuxOutcome } from "./mux/types.ts";
import { MASK } from "./redact.ts";
import { REPORT_SCREEN_ROWS, reportScreen } from "./report.ts";
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
