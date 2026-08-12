import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { defaultSocketPath, envBool, loadConfig, resolveBridgeHost } from "./config.ts";

// loadConfig is the deployment contract — env vars in, a resolved Config out. Pure (just reads
// process.env + homedir), so we drive it by mutating the environment and restoring it after.

const KEYS = [
  "COLLIE_PORT",
  "COLLIE_HOST",
  "COLLIE_POLL_MS",
  "COLLIE_POLL_IDLE_MS",
  "COLLIE_NOTIFY_DELAY_MS",
  "COLLIE_READ_LINES",
  "COLLIE_TRANSCRIPT",
  "COLLIE_TRANSCRIPT_ROOT",
  "COLLIE_CODEX_ROOT",
  "COLLIE_PI_ROOT",
  "COLLIE_OPENCODE_ROOT",
  // Each harness's own home var participates in journal-root resolution, so the suite must own them
  // too — otherwise a developer with CODEX_HOME set gets different results than CI.
  "CODEX_HOME",
  "PI_CODING_AGENT_DIR",
  "XDG_DATA_HOME",
  "COLLIE_SUBMIT_KEYS",
  "COLLIE_TRUSTED_USER",
  "COLLIE_DEVICE_HEADER",
  "COLLIE_DEVICE_ALLOWLIST",
  "COLLIE_ALLOWED_ORIGINS",
  "COLLIE_PUBLIC_HOSTS",
  "COLLIE_VAPID_PUBLIC",
  "COLLIE_VAPID_PRIVATE",
  "COLLIE_VAPID_SUBJECT",
  "COLLIE_STATE_DIR",
  "COLLIE_MULTI_SESSION",
  "COLLIE_SKIP_SERVE",
  "HERDR_SOCKET_PATH",
  "HERDR_PLUGIN_STATE_DIR",
  "COLLIE_HERDR_DIAL",
];

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of KEYS) {
    const v = saved[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("loadConfig", () => {
  test("uses safe single-user defaults", () => {
    const cfg = loadConfig();
    expect(cfg.port).toBe(8787);
    expect(cfg.host).toBe("127.0.0.1");
    expect(cfg.pollMs).toBe(1500);
    expect(cfg.pollIdleMs).toBe(12_000);
    expect(cfg.readLines).toBe(200);
    // Transcript history defaults ON — it's the only scrollback a Claude pane can ever have.
    expect(cfg.transcript).toBe(true);
    expect(cfg.journalRoots.claude).toEndWith("/.claude/projects");
    // OpenCode keeps ONE sqlite database at the top of its XDG data dir — no per-session files.
    expect(cfg.journalRoots.opencode).toEndWith("/.local/share/opencode");
    expect(cfg.submitKeys).toEqual(["Enter"]);
    expect(cfg.trustedUser).toBe("");
    expect(cfg.allowedOrigins).toEqual([]);
    expect(cfg.notifyDelayMs).toBe(30_000);
    // Host-header validation is opt-in (empty = off, legacy behaviour).
    expect(cfg.publicHosts).toEqual([]);
    // Per-device auth is off by default (empty header = feature disabled).
    expect(cfg.deviceHeader).toBe("");
    expect(cfg.deviceAllowlist).toEqual([]);
    // Multi-session support is on by default.
    expect(cfg.multiSession).toBe(true);
    // tailscale serve is used by default (reverse-proxy bypass is opt-in).
    expect(cfg.skipServe).toBe(false);
  });

  test("parses COLLIE_MULTI_SESSION as a boolean toggle (default on)", () => {
    // Falsey spellings turn it off (pin to the primary session only).
    for (const off of ["off", "0", "false", "no", "OFF", " False "]) {
      process.env.COLLIE_MULTI_SESSION = off;
      expect(loadConfig().multiSession).toBe(false);
    }
    // Truthy spellings keep it on.
    for (const on of ["on", "1", "true", "yes", "ON", " True "]) {
      process.env.COLLIE_MULTI_SESSION = on;
      expect(loadConfig().multiSession).toBe(true);
    }
    // Garbage and empty fall back to the default (on).
    process.env.COLLIE_MULTI_SESSION = "banana";
    expect(loadConfig().multiSession).toBe(true);
    process.env.COLLIE_MULTI_SESSION = "";
    expect(loadConfig().multiSession).toBe(true);
  });

  test("parses COLLIE_SKIP_SERVE as a boolean toggle (default off)", () => {
    // Truthy spellings turn it on (reverse-proxy mode; bypass tailscale serve).
    for (const on of ["on", "1", "true", "yes", "ON", " True "]) {
      process.env.COLLIE_SKIP_SERVE = on;
      expect(loadConfig().skipServe).toBe(true);
    }
    // Falsey spellings keep it off (the default tailscale serve path).
    for (const off of ["off", "0", "false", "no", "OFF", " False "]) {
      process.env.COLLIE_SKIP_SERVE = off;
      expect(loadConfig().skipServe).toBe(false);
    }
    // Garbage and empty fall back to the default (off).
    process.env.COLLIE_SKIP_SERVE = "banana";
    expect(loadConfig().skipServe).toBe(false);
    process.env.COLLIE_SKIP_SERVE = "";
    expect(loadConfig().skipServe).toBe(false);
  });

  test("parses COLLIE_TRANSCRIPT as a boolean toggle (default ON)", () => {
    for (const off of ["off", "0", "false", "no", "OFF"]) {
      process.env.COLLIE_TRANSCRIPT = off;
      expect(loadConfig().transcript).toBe(false);
    }
    for (const on of ["on", "1", "true", "yes"]) {
      process.env.COLLIE_TRANSCRIPT = on;
      expect(loadConfig().transcript).toBe(true);
    }
    // Garbage falls back to the default — a typo must not silently remove the only scrollback a
    // Claude pane has.
    process.env.COLLIE_TRANSCRIPT = "banana";
    expect(loadConfig().transcript).toBe(true);
  });

  // COLLIE_TRANSCRIPT_ROOT predates the per-harness split and meant Claude's root — it keeps meaning
  // exactly that, so an existing deployment's env survives the change untouched.
  test("COLLIE_TRANSCRIPT_ROOT relocates the CLAUDE journal root", () => {
    process.env.COLLIE_TRANSCRIPT_ROOT = "/srv/claude/projects";
    expect(loadConfig().journalRoots.claude).toBe("/srv/claude/projects");
  });

  test("each harness's own home var relocates its journal root", () => {
    process.env.CODEX_HOME = "/srv/codex";
    process.env.PI_CODING_AGENT_DIR = "/srv/pi";
    process.env.XDG_DATA_HOME = "/srv/share";
    const cfg = loadConfig();
    expect(cfg.journalRoots.codex).toBe("/srv/codex/sessions");
    expect(cfg.journalRoots.pi).toBe("/srv/pi/sessions");
    expect(cfg.journalRoots.opencode).toBe("/srv/share/opencode");
  });

  test("an explicit COLLIE_* root beats the harness's home var", () => {
    process.env.CODEX_HOME = "/srv/codex";
    process.env.COLLIE_CODEX_ROOT = "/elsewhere/rollouts";
    expect(loadConfig().journalRoots.codex).toBe("/elsewhere/rollouts");
  });

  test("reads the per-device auth header and allowlist", () => {
    process.env.COLLIE_DEVICE_HEADER = "  X-Device-Id  ";
    process.env.COLLIE_DEVICE_ALLOWLIST = " phone , laptop ,";
    const cfg = loadConfig();
    expect(cfg.deviceHeader).toBe("X-Device-Id");
    expect(cfg.deviceAllowlist).toEqual(["phone", "laptop"]);
  });

  test("parses integer env vars and falls back to the default on garbage", () => {
    process.env.COLLIE_PORT = "9999";
    expect(loadConfig().port).toBe(9999);
    process.env.COLLIE_PORT = "not-a-number";
    expect(loadConfig().port).toBe(8787);
  });

  test("rejects trailing-garbage integers (parseInt would have accepted '8080abc')", () => {
    process.env.COLLIE_PORT = "8080abc";
    expect(loadConfig().port).toBe(8787);
    // Surrounding whitespace is still fine.
    process.env.COLLIE_READ_LINES = "  120  ";
    expect(loadConfig().readLines).toBe(120);
  });

  test("clamps out-of-range integers back to the default", () => {
    process.env.COLLIE_PORT = "0";
    expect(loadConfig().port).toBe(8787);
    process.env.COLLIE_PORT = "70000";
    expect(loadConfig().port).toBe(8787);
    process.env.COLLIE_POLL_MS = "100"; // below the 250 floor
    expect(loadConfig().pollMs).toBe(1500);
    process.env.COLLIE_POLL_IDLE_MS = "500"; // below the 1000 floor
    expect(loadConfig().pollIdleMs).toBe(12_000);
    process.env.COLLIE_NOTIFY_DELAY_MS = "-5"; // below the 0 floor
    expect(loadConfig().notifyDelayMs).toBe(30_000);
  });

  test("accepts an in-range integer and a zero notify delay", () => {
    process.env.COLLIE_POLL_MS = "250";
    expect(loadConfig().pollMs).toBe(250);
    process.env.COLLIE_POLL_IDLE_MS = "30000";
    expect(loadConfig().pollIdleMs).toBe(30_000);
    process.env.COLLIE_NOTIFY_DELAY_MS = "0";
    expect(loadConfig().notifyDelayMs).toBe(0);
  });

  test("reads the public-hosts allowlist, trimming and dropping blanks", () => {
    process.env.COLLIE_PUBLIC_HOSTS = " collie.example.ts.net , collie.example.com:8443 ,";
    expect(loadConfig().publicHosts).toEqual([
      "collie.example.ts.net",
      "collie.example.com:8443",
    ]);
  });

  test("splits comma lists, trimming whitespace and dropping blanks", () => {
    process.env.COLLIE_SUBMIT_KEYS = " ctrl+a , Enter ,";
    expect(loadConfig().submitKeys).toEqual(["ctrl+a", "Enter"]);
    process.env.COLLIE_ALLOWED_ORIGINS = "https://a.example.com, https://b.example.com";
    expect(loadConfig().allowedOrigins).toEqual(["https://a.example.com", "https://b.example.com"]);
  });

  test("falls back to [Enter] when COLLIE_SUBMIT_KEYS is empty", () => {
    process.env.COLLIE_SUBMIT_KEYS = "";
    expect(loadConfig().submitKeys).toEqual(["Enter"]);
  });

  test("honours an explicit trusted user and host override", () => {
    process.env.COLLIE_TRUSTED_USER = "me@example.com";
    process.env.COLLIE_HOST = "0.0.0.0";
    const cfg = loadConfig();
    expect(cfg.trustedUser).toBe("me@example.com");
    expect(cfg.host).toBe("0.0.0.0");
  });

  test("dial mode defaults to auto and accepts a forced dialer", () => {
    expect(loadConfig().dialMode).toBe("auto");
    process.env.COLLIE_HERDR_DIAL = "net";
    expect(loadConfig().dialMode).toBe("net");
    process.env.COLLIE_HERDR_DIAL = "BUN"; // case-insensitive
    expect(loadConfig().dialMode).toBe("bun");
  });

  test("an unrecognised dial mode falls back to auto rather than dialling nothing", () => {
    process.env.COLLIE_HERDR_DIAL = "carrier-pigeon";
    expect(loadConfig().dialMode).toBe("auto");
  });
});

// Pure — both platform branches are testable from any host (expectations use join() so the
// host's separator never leaks into the assertion).
describe("defaultSocketPath", () => {
  test("unix default lives under ~/.config/herdr", () => {
    expect(defaultSocketPath("linux", {}, "/home/u")).toBe(join("/home/u", ".config", "herdr", "herdr.sock"));
    expect(defaultSocketPath("darwin", {}, "/Users/u")).toBe(join("/Users/u", ".config", "herdr", "herdr.sock"));
  });

  test("win32 default honours APPDATA", () => {
    expect(defaultSocketPath("win32", { APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, "C:\\Users\\u")).toBe(
      join("C:\\Users\\u\\AppData\\Roaming", "herdr", "herdr.sock"),
    );
  });

  test("win32 falls back to <home>/AppData/Roaming when APPDATA is unset", () => {
    expect(defaultSocketPath("win32", {}, "C:\\Users\\u")).toBe(
      join("C:\\Users\\u", "AppData", "Roaming", "herdr", "herdr.sock"),
    );
  });
});

// Also the source `cli/doctor.ts`'s bind check and `cli/lifecycle.ts`'s readiness probe read, so a
// peer's COLLIE_HOST resolves identically wherever it's asked.
describe("resolveBridgeHost", () => {
  test("absent COLLIE_HOST resolves to loopback", () => {
    expect(resolveBridgeHost({})).toBe("127.0.0.1");
  });

  test("an explicit COLLIE_HOST is used verbatim — a peer's tailnet address, say", () => {
    expect(resolveBridgeHost({ COLLIE_HOST: "100.64.0.8" })).toBe("100.64.0.8");
  });

  test("explicitly empty is passed through, not defaulted — the wildcard-bind case", () => {
    expect(resolveBridgeHost({ COLLIE_HOST: "" })).toBe("");
  });
});

// Exported so mode-scoped config (bridge/pack/config.ts) parses its env in this exact style instead
// of growing a second reader. The env source is injectable, which is the only new thing here — the
// truth table below is the one loadConfig has always used.
describe("envBool", () => {
  test("empty and unset fall back", () => {
    expect(envBool("X", true, {})).toBe(true);
    expect(envBool("X", false, {})).toBe(false);
    expect(envBool("X", true, { X: "" })).toBe(true);
    expect(envBool("X", true, { X: "   " })).toBe(true);
  });

  test("the truthy and falsy vocabularies, case-insensitively", () => {
    for (const v of ["on", "1", "true", "yes", "TRUE", " Yes "]) expect(envBool("X", false, { X: v })).toBe(true);
    for (const v of ["off", "0", "false", "no", "OFF", " No "]) expect(envBool("X", true, { X: v })).toBe(false);
  });

  test("garbage falls back rather than silently flipping a feature", () => {
    expect(envBool("X", true, { X: "maybe" })).toBe(true);
    expect(envBool("X", false, { X: "maybe" })).toBe(false);
  });

  test("defaults to process.env when no source is given", () => {
    process.env.COLLIE_MULTI_SESSION = "off";
    expect(envBool("COLLIE_MULTI_SESSION", true)).toBe(false);
  });
});
