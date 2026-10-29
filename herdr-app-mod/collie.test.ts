import { describe, expect, test } from "bun:test";
import jsQR from "jsqr";

import { qrModules } from "../scripts/qr.ts";
import {
  actions,
  collieCommand,
  describe as describePanel,
  minutesLeft,
  moduleSize,
  openCommand,
  pickInstance,
  qrRuns,
  readHealth,
  readPair,
  readStatus,
  summary,
} from "./collie/model.js";

// The herdr-app panel's decisions (herdr-app-mod/collie/model.js). main.js only draws what these
// return, and `herdr-app check` proves it draws; these prove what it says and which program it runs.

const STATUS = {
  running: true,
  version: "1.26.0+abc1234",
  instance: null,
  port: 8787,
  localUrl: "http://127.0.0.1:8787",
  phoneUrl: "https://host.example",
  crew: "solo",
  service: "systemd --user (collie) · active",
  pairedDevices: 1,
};

const ok = (stdout: string, code = 0, stderr = "") => ({ code, stdout, stderr });

describe("which program the panel runs", () => {
  test("the default instance is plain `collie`, and status and pair ask for JSON", () => {
    expect(collieCommand("status", null, "linux")).toEqual({ command: "collie", args: ["status", "--json"] });
    expect(collieCommand("pair", null, "linux")).toEqual({ command: "collie", args: ["pair", "--json"] });
    expect(collieCommand("restart", null, "macos")).toEqual({ command: "collie", args: ["restart"] });
  });

  test("a named instance goes through env, and Windows refuses it rather than guessing", () => {
    expect(collieCommand("stop", "next", "linux")).toEqual({
      command: "env",
      args: ["COLLIE_INSTANCE=next", "collie", "stop"],
    });
    expect(collieCommand("stop", "next", "windows")).toBeNull();
    expect(collieCommand("stop", null, "windows")).toEqual({ command: "collie", args: ["stop"] });
  });

  test("only the panel's own verbs reach exec", () => {
    expect(() => collieCommand("uninstall", null, "linux")).toThrow(/not a panel verb/);
    expect(() => collieCommand("update", null, "linux")).toThrow(/not a panel verb/);
  });

  test("an instance prop must be a name Collie accepts", () => {
    expect(pickInstance(undefined)).toEqual({ ok: true, instance: null });
    expect(pickInstance({ instance: "default" })).toEqual({ ok: true, instance: null });
    expect(pickInstance({ instance: "next" })).toEqual({ ok: true, instance: "next" });
    expect(pickInstance({ instance: "Next; rm" }).ok).toBe(false);
    expect(pickInstance({ instance: "x".repeat(17) }).ok).toBe(false);
  });

  test("the URL opens with the platform's own opener", () => {
    expect(openCommand("linux", "http://h:1").command).toBe("xdg-open");
    expect(openCommand("macos", "http://h:1").command).toBe("open");
    expect(openCommand("windows", "http://h:1").args).toEqual(["url.dll,FileProtocolHandler", "http://h:1"]);
  });
});

describe("reading collie status --json", () => {
  test("the JSON line becomes the status", () => {
    const read = readStatus(ok(`${JSON.stringify(STATUS)}\n`));
    expect(read).toEqual({ ok: true, status: STATUS });
  });

  test("a Collie from before the flag prints its banner: too old, not broken", () => {
    const banner = "\n  ✓ Collie is running  ·  v1.24.2+744faa49\n    service   systemd --user (collie) · active\n";
    expect(readStatus(ok(banner))).toEqual({ ok: false, kind: "old" });
    const cold = "\n  ⚠ Collie isn't answering on :8787 yet (v1.24.2) — check 'collie logs'\n";
    expect(readStatus(ok(cold))).toEqual({ ok: false, kind: "old" });
  });

  test("anything else is a failure with Collie's own words", () => {
    const read = readStatus(ok("", 1, "error: COLLIE_INSTANCE=\"x\" but no config at /c/.env\n"));
    expect(read.ok).toBe(false);
    expect(read).toMatchObject({ kind: "failed", text: expect.stringContaining("no config") });
  });

  test("health gives the served version and the mode, and nothing from a wrong body", () => {
    expect(readHealth({ ok: true, version: "1.26.0", deposed: false, mode: "lead" })).toEqual({ version: "1.26.0", mode: "lead" });
    expect(readHealth(null)).toBeNull();
    expect(readHealth({ error: "nope" })).toBeNull();
  });
});

describe("reading collie pair --json", () => {
  const NOW = 1_700_000_000_000;
  const PAIR = {
    code: "ABCD2345",
    expiresAt: new Date(NOW + 600_000).toISOString(),
    tokenLifetimeMs: null,
    replaced: false,
    url: "https://host.example/settings?pair=ABCD2345",
    qr: ["101", "010", "101"],
  };

  test("the code, its expiry, the URL and the bitmap", () => {
    const read = readPair(ok(JSON.stringify(PAIR)), NOW);
    expect(read).toEqual({
      ok: true,
      pairing: { code: "ABCD2345", expiresAt: NOW + 600_000, url: PAIR.url, qr: PAIR.qr, replaced: false },
    });
  });

  test("a bitmap that is not rows of 0 and 1 is dropped, the code stays", () => {
    const read = readPair(ok(JSON.stringify({ ...PAIR, qr: ["10x"] })), NOW);
    expect(read).toMatchObject({ ok: true, pairing: { code: "ABCD2345", qr: null } });
  });

  test("a Collie from before the flag refuses it as usage and mints nothing: too old", () => {
    const stderr = "error: unknown argument `--json`\nusage: collie pair [--expires <duration>]   durations: 12h, 30d, 2w\n";
    expect(readPair(ok("", 2, stderr), NOW)).toEqual({ ok: false, kind: "old" });
  });

  test("minutes left round up and stop at zero", () => {
    expect(minutesLeft(NOW + 600_000, NOW)).toBe(10);
    expect(minutesLeft(NOW + 61_000, NOW)).toBe(2);
    expect(minutesLeft(NOW - 1, NOW)).toBe(0);
  });
});

describe("the QR code the panel draws", () => {
  // Paint the runs the panel draws, one module to SCALE² pixels, and scan them with a real decoder.
  function scanRuns(runs: { dark: boolean; length: number }[][], scale = 4): string | null {
    const width = runs[0]!.reduce((n, r) => n + r.length, 0) * scale;
    const height = runs.length * scale;
    const data = new Uint8ClampedArray(width * height * 4).fill(255);
    runs.forEach((row, r) => {
      let x = 0;
      for (const run of row) {
        for (let i = 0; i < run.length * scale; i++, x++) {
          if (!run.dark) continue;
          for (let dy = 0; dy < scale; dy++) {
            const at = ((r * scale + dy) * width + x) * 4;
            data[at] = data[at + 1] = data[at + 2] = 0;
          }
        }
      }
    });
    return jsQR(data, width, height)?.data ?? null;
  }

  test("collie pair's bitmap, drawn as runs with a quiet zone, scans back to the URL", async () => {
    const url = "https://my-laptop.tailnet-example.ts.net/settings?pair=ABCD2345";
    const rows = await qrModules(url);
    const runs = qrRuns(rows);
    expect(runs).toHaveLength(rows.length + 8);
    for (const row of runs) expect(row.reduce((n, r) => n + r.length, 0)).toBe(rows.length + 8);
    expect(scanRuns(runs)).toBe(url);
  });

  test("modules stay between 2 and 6 pixels and fit the width", () => {
    expect(moduleSize(260, 29)).toBe(6);
    expect(moduleSize(150, 29)).toBe(4);
    expect(moduleSize(40, 29)).toBe(2);
  });
});

describe("what the panel says and allows", () => {
  const idle = { status: STATUS, health: { version: "1.26.0+abc1234", mode: "solo" }, problem: null, busy: null };

  test("running: version, mode, port, service and paired devices; every action but Start", () => {
    const view = describePanel(idle);
    expect(view.headline).toBe("Collie is running");
    expect(view.mark).toBe("running");
    expect(view.rows.map((r: { label: string }) => r.label)).toEqual(["Version", "Mode", "Port", "Service", "Paired"]);
    expect(view.rows.find((r: { label: string }) => r.label === "Paired")?.value).toBe("1 device");
    expect(actions(idle)).toEqual({ start: false, stop: true, restart: true, pair: true, pushTest: true, open: true });
  });

  test("stopped: only Start, and Open while a phone URL is known", () => {
    const stopped = { ...idle, status: { ...STATUS, running: false }, health: null };
    expect(describePanel(stopped).headline).toBe("Collie is stopped");
    expect(actions(stopped)).toEqual({ start: true, stop: false, restart: false, pair: false, pushTest: false, open: true });
  });

  test("nothing acts while a verb runs", () => {
    const busy = actions({ ...idle, busy: "restart" });
    expect([busy.start, busy.stop, busy.restart, busy.pair, busy.pushTest]).toEqual([false, false, false, false, false]);
  });

  test("a peer pairs nothing here and says where to pair", () => {
    const peer = { ...idle, status: { ...STATUS, crew: "peer", phoneUrl: null } };
    expect(actions(peer).pair).toBe(false);
    expect(actions(peer).open).toBe(false);
    expect(describePanel(peer).detail).toContain("lead");
  });

  test("no collie, an old collie and a named instance on Windows each say what to do", () => {
    expect(describePanel({ ...idle, status: null, problem: { kind: "missing" } }).headline).toBe("Collie is not installed here");
    expect(describePanel({ ...idle, status: null, problem: { kind: "old" } }).detail).toContain("collie update");
    expect(actions({ ...idle, status: null, problem: { kind: "old" } }).start).toBe(false);
    expect(describePanel({ ...idle, status: null, problem: { kind: "instance", text: "why" } }).detail).toBe("why");
  });

  test("a run's last line is what the note shows, colours and QR glyphs stripped", () => {
    expect(summary(ok("\u001b[32m✓ started\u001b[0m\nbridge up on :8787\n"))).toBe("bridge up on :8787");
    expect(summary(ok("partial\n", 1, "error: the unit failed\nmore\n"))).toBe("error: the unit failed");
    expect(summary(ok("█▀▄ █\n"))).toBe("");
  });
});
