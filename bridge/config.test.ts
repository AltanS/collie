import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadConfig } from "./config.ts";

// loadConfig is the deployment contract — env vars in, a resolved Config out. Pure (just reads
// process.env + homedir), so we drive it by mutating the environment and restoring it after.

const KEYS = [
  "COLLIE_PORT",
  "COLLIE_HOST",
  "COLLIE_POLL_MS",
  "COLLIE_POLL_IDLE_MS",
  "COLLIE_NOTIFY_DELAY_MS",
  "COLLIE_READ_LINES",
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
  "HERDR_SOCKET_PATH",
  "HERDR_PLUGIN_STATE_DIR",
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
    expect(cfg.submitKeys).toEqual(["Enter"]);
    expect(cfg.trustedUser).toBe("");
    expect(cfg.allowedOrigins).toEqual([]);
    expect(cfg.notifyDelayMs).toBe(30_000);
    // Host-header validation is opt-in (empty = off, legacy behaviour).
    expect(cfg.publicHosts).toEqual([]);
    // Per-device auth is off by default (empty header = feature disabled).
    expect(cfg.deviceHeader).toBe("");
    expect(cfg.deviceAllowlist).toEqual([]);
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
});
