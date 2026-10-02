import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hostFor } from "../bridge/host.ts";
import {
  AGENT_FILE_MODE,
  agentFilePath,
  bridgeCommand,
  bridgeEnvironment,
  collieBinary,
  launchAgentPlist,
  bakedTailscaleHosts,
  type ServiceSpec,
  superviseArgs,
  systemdUnit,
  taskAction,
  taskFilePath,
  taskXml,
  unitDirectives,
  unitFilePath,
  windowsArg,
  xmlAscii,
  xmlEscape,
} from "./unit.ts";
import { parseSuperviseArgs, parseWindowsArgs } from "./task-scheduler.ts";

// The service definition is the one artifact an operator never sees us write and can't easily
// inspect — it lands in ~/.config or ~/Library and is read by a daemon at login. So its full text
// is pinned here: every field the shell carried, including the ones whose only justification is a
// comment above them.

// The unit and the plist spell a few paths through `join` (the env file, the log, the unit and plist
// locations), so on a Windows host those come out with backslashes. The expectations build the same
// paths the same way; a path the spec hands over verbatim is still compared as the literal it is.
const ENV_FILE = join("/home/pat/.config/collie", ".env");
const LOG_FILE = join("/home/pat/.config/collie", "collie.log");
const V1_LOG_FILE = join("/home/pat/.config/collie", "collie-v1.log");

const SPEC: ServiceSpec = {
  root: "/opt/collie",
  instance: null,
  binary: "/opt/collie/bin/collie",
  configDir: "/home/pat/.config/collie",
  socket: "/home/pat/.config/herdr/herdr.sock",
  port: 8787,
  tailscaleHosts: "",
};

describe("the discovered Host allowlist", () => {
  test("an empty value writes NO line — an empty one in the unit is a lockout, not a default", () => {
    expect(systemdUnit(SPEC)).not.toContain("COLLIE_TAILSCALE_HOSTS");
    expect(launchAgentPlist(SPEC)).not.toContain("COLLIE_TAILSCALE_HOSTS");
  });

  test("a discovered value is baked into both supervisors", () => {
    const spec = { ...SPEC, tailscaleHosts: "desk.ts.net,100.64.0.1" };
    expect(systemdUnit(spec)).toContain("Environment=COLLIE_TAILSCALE_HOSTS=desk.ts.net,100.64.0.1");
    expect(launchAgentPlist(spec)).toContain(
      "<key>COLLIE_TAILSCALE_HOSTS</key>\n        <string>desk.ts.net,100.64.0.1</string>",
    );
  });

  test("bakedTailscaleHosts reads back what either supervisor wrote, and nothing else", () => {
    const spec = { ...SPEC, tailscaleHosts: "desk.ts.net" };
    expect(bakedTailscaleHosts(systemdUnit(spec))).toBe("desk.ts.net");
    expect(bakedTailscaleHosts(launchAgentPlist(spec))).toBe("desk.ts.net");
    expect(bakedTailscaleHosts(systemdUnit(SPEC))).toBe("");
    expect(bakedTailscaleHosts(null)).toBe("");
  });
});

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
EnvironmentFile=-${ENV_FILE}

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
    expect(unit).toContain(`EnvironmentFile=-${ENV_FILE}`);
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
    expect(plist).toContain(`<key>StandardOutPath</key>\n    <string>${LOG_FILE}</string>`);
    expect(plist).toContain(`<key>StandardErrorPath</key>\n    <string>${LOG_FILE}</string>`);
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
    // A pinned host joins with its own separator, never the machine's, so the answer is a literal.
    expect(collieBinary("/opt/collie", hostFor("linux"))).toBe("/opt/collie/bin/collie");
    expect(collieBinary("/opt/collie", hostFor("darwin"))).toBe("/opt/collie/bin/collie");
    expect(bridgeCommand(SPEC)).toEqual(["/opt/collie/bin/collie", "_exec-bridge"]);
  });

  test("on Windows it is bin/collie.exe, the file Bun's compiler writes and an existence check can find", () => {
    expect(collieBinary("C:\\opt\\collie", hostFor("win32"))).toBe("C:\\opt\\collie\\bin\\collie.exe");
  });

  test("unit and agent land where the supervisors look", () => {
    expect(unitFilePath("/home/pat")).toBe(join("/home/pat", ".config", "systemd", "user", "collie.service"));
    expect(agentFilePath("/home/pat")).toBe(join("/home/pat", "Library", "LaunchAgents", "herdr.collie.plist"));
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
    expect(unitFilePath("/home/pat", "v1")).toBe(
      join("/home/pat", ".config", "systemd", "user", "collie-v1.service"),
    );
    expect(unitFilePath("/home/pat")).toBe(join("/home/pat", ".config", "systemd", "user", "collie.service"));
    expect(agentFilePath("/home/pat", "v1")).toBe(
      join("/home/pat", "Library", "LaunchAgents", "herdr.collie-v1.plist"),
    );
    expect(agentFilePath("/home/pat")).toBe(join("/home/pat", "Library", "LaunchAgents", "herdr.collie.plist"));
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
    expect(plist).toContain(`<string>${V1_LOG_FILE}</string>`);
    expect(launchAgentPlist(SPEC)).toContain(`<string>${LOG_FILE}</string>`);
  });
});

// The third definition, pinned like the other two. Windows spells its paths with backslashes, so the
// spec here is a Windows one: these are strings, and nothing below touches a file.
describe("the Task Scheduler task (Windows)", () => {
  const WIN_SPEC: ServiceSpec = {
    root: "C:\\Users\\pat\\collie",
    instance: null,
    binary: "C:\\Users\\pat\\collie\\bin\\collie.exe",
    configDir: "C:\\Users\\pat\\AppData\\Roaming\\herdr\\plugins\\config\\herdr.collie",
    socket: "\\\\.\\pipe\\herdr",
    port: 8787,
    tailscaleHosts: "",
  };
  const CONHOST = "C:\\WINDOWS\\system32\\conhost.exe";

  test("is exactly this text: logon trigger, limited token, no time limit, the launcher under conhost", () => {
    expect(taskXml(WIN_SPEC, { user: "desk\\pat", runLevel: "LeastPrivilege", conhost: CONHOST })).toBe(
      `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Collie</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>desk\\pat</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>desk\\pat</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>C:\\WINDOWS\\system32\\conhost.exe</Command>
      <Arguments>--headless C:\\Users\\pat\\collie\\bin\\collie.exe _supervise HERDR_SOCKET_PATH=\\\\.\\pipe\\herdr COLLIE_PORT=8787 HERDR_PLUGIN_CONFIG_DIR=C:\\Users\\pat\\AppData\\Roaming\\herdr\\plugins\\config\\herdr.collie COLLIE_PLUGIN_ROOT=C:\\Users\\pat\\collie</Arguments>
      <WorkingDirectory>C:\\Users\\pat\\collie</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`,
    );
  });

  test("has no XML declaration, and spells every non-ASCII character as a reference", () => {
    const spec = { ...WIN_SPEC, root: "C:\\Users\\Zoë\\collie & co", binary: "C:\\Users\\Zoë\\collie & co\\bin\\collie.exe" };
    const xml = taskXml(spec, { user: "desk\\Zoë", runLevel: "LeastPrivilege", conhost: CONHOST });
    expect(xml.startsWith("<Task ")).toBe(true);
    expect([...xml].every((ch) => ch === "\n" || (ch >= " " && ch <= "~"))).toBe(true);
    expect(xml).toContain("<UserId>desk\\Zo&#xeb;</UserId>");
    expect(xml).toContain("<WorkingDirectory>C:\\Users\\Zo&#xeb;\\collie &amp; co</WorkingDirectory>");
    // A path with a blank is quoted for the launcher's argv, and the quote survives the XML.
    expect(xml).toContain('--headless "C:\\Users\\Zo&#xeb;\\collie &amp; co\\bin\\collie.exe" _supervise');
    expect(xmlAscii("a\u{1F600}b")).toBe("a&#x1f600;b");
  });

  test("pins every setting that is not Task Scheduler's default", () => {
    const xml = taskXml(WIN_SPEC, { user: "desk\\pat", runLevel: "LeastPrivilege", conhost: CONHOST });
    // The 72 h default would silently end the supervisor three days after logon.
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>");
    expect(xml).toContain("<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>");
    expect(xml).toContain("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>");
    expect(xml).toContain("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>");
    expect(xml).toContain("<StartWhenAvailable>true</StartWhenAvailable>");
    // The outer net, for the launcher alone: the launcher's loop owns the bridge.
    expect(xml).toContain("<RestartOnFailure>\n      <Interval>PT1M</Interval>\n      <Count>999</Count>");
  });

  // `&`, `'`, `<`, a blank and a character outside the Basic Multilingual Plane, in the user, the
  // folder and a KEY=value word. The XML must carry each as itself (one reference per code point,
  // never two surrogate halves), and the launcher must read back the exact words the task was given.
  test("escapes a hostile path end to end: XML, then the launcher's command line", () => {
    const odd = "C:\\Users\\O'Neil & <Co> \u{1F600}\\collie";
    const spec: ServiceSpec = {
      ...WIN_SPEC,
      root: odd,
      binary: `${odd}\\bin\\collie.exe`,
      configDir: `${odd}\\cfg dir\\`,
      tailscaleHosts: "desk.ts.net",
    };
    const user = "desk\\O'Neil & <Co> \u{1F600}";
    const xml = taskXml(spec, { user, runLevel: "LeastPrivilege", conhost: CONHOST });
    expect(xml).toContain("<UserId>desk\\O'Neil &amp; &lt;Co&gt; &#x1f600;</UserId>");
    expect(xml).not.toMatch(/&#xd8[0-9a-f]{2};/);
    expect([...xml].every((ch) => ch === "\n" || (ch >= " " && ch <= "~"))).toBe(true);

    // What Task Scheduler hands conhost, decoded from the XML exactly as an XML reader would.
    const encoded = /<Arguments>([^<]*)<\/Arguments>/.exec(xml)?.[1] ?? "";
    const decoded = encoded
      .replace(/&#x([0-9a-f]+);/g, (_m, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replaceAll("&lt;", "<")
      .replaceAll("&gt;", ">")
      .replaceAll("&amp;", "&");
    // conhost runs the rest of its line verbatim; the launcher splits it by CommandLineToArgvW.
    const [headless, program, verb, ...words] = parseWindowsArgs(decoded);
    expect(headless).toBe("--headless");
    expect(program).toBe(spec.binary);
    expect(verb).toBe("_supervise");
    expect(parseSuperviseArgs(words)).toEqual({ instance: null, env: bridgeEnvironment(spec) });
    expect(bridgeEnvironment(spec).HERDR_PLUGIN_CONFIG_DIR).toBe(`${odd}\\cfg dir\\`);
  });

  test("parseWindowsArgs reads back every word windowsArg writes", () => {
    const words = ["plain", "", "a b", 'say "hi"', "C:\\with space\\", "a\\\\b", 'x\\"y z', "\\\\.\\pipe\\herdr"];
    expect(parseWindowsArgs(words.map(windowsArg).join(" "))).toEqual(words);
    expect(parseWindowsArgs('  one\ttwo  "three four" ')).toEqual(["one", "two", "three four"]);
  });

  test("the elevated task differs only in its run level, and a suffixed instance says so", () => {
    const base = taskXml(WIN_SPEC, { user: "desk\\pat", runLevel: "LeastPrivilege", conhost: CONHOST });
    const high = taskXml(WIN_SPEC, { user: "desk\\pat", runLevel: "HighestAvailable", conhost: CONHOST });
    expect(high).toBe(base.replace("LeastPrivilege", "HighestAvailable"));
    const v1 = taskXml({ ...WIN_SPEC, instance: "v1" }, { user: "desk\\pat", runLevel: "LeastPrivilege", conhost: CONHOST });
    expect(v1).toContain("<Description>Collie (instance v1)</Description>");
    expect(v1).toContain("_supervise --instance v1 HERDR_SOCKET_PATH=");
    expect(v1).toContain("COLLIE_INSTANCE=v1");
  });

  test("without conhost the task runs the binary itself", () => {
    expect(taskAction(WIN_SPEC, null)).toEqual({
      command: WIN_SPEC.binary,
      arguments: superviseArgs(WIN_SPEC).map(windowsArg).join(" "),
    });
  });

  test("the launcher reads back exactly the words the task writes", () => {
    const spec = { ...WIN_SPEC, instance: "v1", tailscaleHosts: "desk.ts.net,100.64.0.1" };
    const argv = superviseArgs(spec);
    expect(argv.slice(0, 3)).toEqual(["_supervise", "--instance", "v1"]);
    expect(parseSuperviseArgs(argv.slice(1))).toEqual({ instance: "v1", env: bridgeEnvironment(spec) });
  });

  test("windowsArg quotes the way a Windows program parses its command line", () => {
    expect(windowsArg("plain")).toBe("plain");
    expect(windowsArg("C:\\x\\y")).toBe("C:\\x\\y");
    expect(windowsArg("\\\\.\\pipe\\herdr")).toBe("\\\\.\\pipe\\herdr");
    expect(windowsArg("")).toBe('""');
    expect(windowsArg("C:\\Program Files\\x")).toBe('"C:\\Program Files\\x"');
    // A run of backslashes before the closing quote doubles, or it would escape the quote.
    expect(windowsArg("C:\\with space\\")).toBe('"C:\\with space\\\\"');
    expect(windowsArg('say "hi"')).toBe('"say \\"hi\\""');
    expect(windowsArg('a\\"b c')).toBe('"a\\\\\\"b c"');
  });

  test("the task file sits beside .env, named after the task", () => {
    const win = hostFor("win32");
    expect(taskFilePath("C:\\cfg", null, win)).toBe("C:\\cfg\\herdr.collie.task.xml");
    expect(taskFilePath("C:\\cfg", "v1", win)).toBe("C:\\cfg\\herdr.collie-v1.task.xml");
  });
});
