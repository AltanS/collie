import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  AGENT_FILE_MODE,
  agentFilePath,
  bridgeCommand,
  bridgeEnvironment,
  collieBinary,
  launchAgentPlist,
  type ServiceSpec,
  systemdUnit,
  unitDirectives,
  unitFilePath,
  xmlEscape,
} from "./unit.ts";

// The service definition is the one artifact an operator never sees us write and can't easily
// inspect — it lands in ~/.config or ~/Library and is read by a daemon at login. So its full text
// is pinned here: every field the shell carried, including the ones whose only justification is a
// comment above them.

const SPEC: ServiceSpec = {
  root: "/opt/collie",
  instance: null,
  binary: "/opt/collie/bin/collie",
  configDir: "/home/pat/.config/collie",
  socket: "/home/pat/.config/herdr/herdr.sock",
  port: 8787,
};

describe("the systemd unit", () => {
  const unit = systemdUnit(SPEC);

  test("is exactly the text the shell wrote, with the binary as ExecStart", () => {
    expect(unit).toBe(`[Unit]
Description=Collie
After=default.target
# Never give up restarting — a phone-only operator can't run 'systemctl reset-failed'.
StartLimitIntervalSec=0

[Service]
Type=simple
WorkingDirectory=/opt/collie
ExecStart=/opt/collie/bin/collie _exec-bridge
Restart=on-failure
RestartSec=5
# Hardening: the bridge is remote shell access, so deny privilege escalation and give it a private
# /tmp. ProtectSystem is intentionally NOT set — the only write path is the env-driven state dir,
# which Herdr may inject to an arbitrary location, so it can't be enumerated in a static ReadWritePaths.
NoNewPrivileges=yes
PrivateTmp=yes
Environment=HERDR_SOCKET_PATH=/home/pat/.config/herdr/herdr.sock
Environment=COLLIE_PORT=8787
Environment=HERDR_PLUGIN_CONFIG_DIR=/home/pat/.config/collie
Environment=COLLIE_PLUGIN_ROOT=/opt/collie
# Leading '-': a missing .env is not a startup failure.
EnvironmentFile=-/home/pat/.config/collie/.env

[Install]
WantedBy=default.target
`);
  });

  test("keeps the fields whose only justification is a comment", () => {
    // A phone-only operator cannot run `systemctl reset-failed`, so the start limit is disabled.
    expect(unit).toContain("StartLimitIntervalSec=0");
    expect(unit).toContain("NoNewPrivileges=yes");
    expect(unit).toContain("PrivateTmp=yes");
    // ProtectSystem is deliberately absent: the state dir is env-driven and can't be enumerated in
    // a static ReadWritePaths.
    expect(unit).not.toContain("ProtectSystem=");
    // Leading `-`: a missing .env must not be a startup failure.
    expect(unit).toContain("EnvironmentFile=-/home/pat/.config/collie/.env");
  });

  test("never puts Bun on the runtime path", () => {
    expect(unit).not.toMatch(/\bbun\b/i);
  });
});

describe("systemd/collie.service, the hand-managed reference", () => {
  const reference = readFileSync(
    join(import.meta.dir, "..", "systemd", "collie.service"),
    "utf8",
  );

  test("declares the same directives, in the same order, as the generator", () => {
    expect(unitDirectives(reference)).toEqual(unitDirectives(systemdUnit(SPEC)));
  });

  test("runs the binary, not an interpreter", () => {
    expect(reference).toContain("ExecStart=@PLUGIN_ROOT@/bin/collie _exec-bridge");
  });
});

describe("the launchd agent", () => {
  const plist = launchAgentPlist(SPEC);

  test("mirrors the unit field for field", () => {
    expect(plist).toContain("<string>herdr.collie</string>");
    // WantedBy=default.target → RunAtLoad; Restart=on-failure → KeepAlive/SuccessfulExit;
    // RestartSec=5 → ThrottleInterval.
    expect(plist).toContain("<key>RunAtLoad</key>");
    expect(plist).toContain("<key>SuccessfulExit</key>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n    <integer>5</integer>");
    expect(plist).toContain("<key>WorkingDirectory</key>\n    <string>/opt/collie</string>");
  });

  test("runs the binary directly — no /bin/bash wrapper", () => {
    expect(plist).toContain("<string>/opt/collie/bin/collie</string>");
    expect(plist).toContain("<string>_exec-bridge</string>");
    expect(plist).not.toContain("/bin/bash");
  });

  test("carries paths only, never config values", () => {
    // .env is mode 600 and may hold COLLIE_VAPID_PRIVATE; the plist has to stay readable, so the
    // only environment it may name is paths.
    const env = bridgeEnvironment(SPEC);
    expect(Object.keys(env)).toEqual([
      "HERDR_SOCKET_PATH",
      "COLLIE_PORT",
      "HERDR_PLUGIN_CONFIG_DIR",
      "COLLIE_PLUGIN_ROOT",
    ]);
    const secretish = launchAgentPlist({ ...SPEC, configDir: "/cfg" });
    expect(secretish).not.toContain("VAPID");
  });

  test("logs to the config dir, both streams", () => {
    expect(plist).toContain(
      "<key>StandardOutPath</key>\n    <string>/home/pat/.config/collie/collie.log</string>",
    );
    expect(plist).toContain(
      "<key>StandardErrorPath</key>\n    <string>/home/pat/.config/collie/collie.log</string>",
    );
  });

  test("XML-escapes every interpolated path", () => {
    // A checkout path containing `&` or `<` would otherwise emit a plist launchd cannot parse —
    // and an unparseable plist means the agent silently never starts.
    const hostile = launchAgentPlist({
      ...SPEC,
      root: "/opt/a&b<c>",
      binary: "/opt/a&b<c>/bin/collie",
    });
    expect(hostile).toContain("<string>/opt/a&amp;b&lt;c&gt;</string>");
    expect(hostile).not.toContain("<string>/opt/a&b<c>");
  });

  test("is mode 644 — launchd refuses a world-writable plist", () => {
    expect(AGENT_FILE_MODE).toBe(0o644);
  });
});

describe("paths and escaping", () => {
  test("the binary lives at <checkout>/bin/collie", () => {
    expect(collieBinary("/opt/collie")).toBe("/opt/collie/bin/collie");
    expect(bridgeCommand(SPEC)).toEqual(["/opt/collie/bin/collie", "_exec-bridge"]);
  });

  test("unit and agent land where the supervisors look", () => {
    expect(unitFilePath("/home/pat")).toBe("/home/pat/.config/systemd/user/collie.service");
    expect(agentFilePath("/home/pat")).toBe("/home/pat/Library/LaunchAgents/herdr.collie.plist");
  });

  test("xmlEscape does ampersands first", () => {
    // `&` last would re-escape the ampersands the `<`/`>` rules introduce.
    expect(xmlEscape("a&b<c>d")).toBe("a&amp;b&lt;c&gt;d");
  });
});

// ── A second instance's service definition ───────────────────────────────────
// Same checkout, same binary, different service. Pinned in full for the same reason the solo unit is:
// an operator never watches us write it, and a collision here is two services fighting over one name.

describe("a suffixed instance", () => {
  const V1: ServiceSpec = { ...SPEC, instance: "v1", port: 8788 };

  test("names its own unit file and launchd plist, and leaves the solo names free", () => {
    expect(unitFilePath("/home/pat", "v1")).toBe("/home/pat/.config/systemd/user/collie-v1.service");
    expect(unitFilePath("/home/pat")).toBe("/home/pat/.config/systemd/user/collie.service");
    expect(agentFilePath("/home/pat", "v1")).toBe("/home/pat/Library/LaunchAgents/herdr.collie-v1.plist");
    expect(agentFilePath("/home/pat")).toBe("/home/pat/Library/LaunchAgents/herdr.collie.plist");
  });

  test("carries the instance in argv and in the environment, and the solo spec carries neither", () => {
    expect(bridgeCommand(V1)).toEqual(["/opt/collie/bin/collie", "_exec-bridge", "--instance", "v1"]);
    expect(bridgeCommand(SPEC)).toEqual(["/opt/collie/bin/collie", "_exec-bridge"]);
    expect(bridgeEnvironment(V1).COLLIE_INSTANCE).toBe("v1");
    expect(bridgeEnvironment(SPEC)).not.toHaveProperty("COLLIE_INSTANCE");
  });

  test("the unit differs from the solo one in exactly the instance-bearing lines", () => {
    const solo = systemdUnit(SPEC).split("\n");
    const v1 = systemdUnit(V1).split("\n");
    const changed = v1.filter((line) => !solo.includes(line)).filter((l) => l !== "");
    expect(changed).toEqual([
      "Description=Collie (instance v1)",
      "ExecStart=/opt/collie/bin/collie _exec-bridge --instance v1",
      "Environment=COLLIE_PORT=8788",
      "Environment=COLLIE_INSTANCE=v1",
    ]);
    // The directive SHAPE is unchanged but for the one added Environment= — the hand-managed
    // reference unit stays a valid description of the solo service.
    expect(unitDirectives(systemdUnit(V1)).filter((d) => d !== "Environment=COLLIE_INSTANCE")).toEqual(
      unitDirectives(systemdUnit(SPEC)),
    );
  });

  test("the plist's label and log path are the instance's own", () => {
    const plist = launchAgentPlist(V1);
    expect(plist).toContain("<string>herdr.collie-v1</string>");
    expect(plist).toContain("<string>/home/pat/.config/collie/collie-v1.log</string>");
    expect(launchAgentPlist(SPEC)).toContain("<string>/home/pat/.config/collie/collie.log</string>");
  });
});
