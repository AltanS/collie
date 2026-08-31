import { describe, expect, test } from "bun:test";

import { leadStore, member, peerStore } from "../bridge/pack/fixtures.ts";
import { serializeTrustStore } from "../bridge/pack/trust-store.ts";
import {
  capture,
  CONFIG,
  context,
  STATE,
  type FakeExec,
  fakeExec,
  type FakeFiles,
  fakeFiles,
  HANDLER_FILE,
  type Scripted,
} from "./fakes.ts";
import { EXIT } from "./io.ts";
import {
  cmdServe,
  cmdUnserve,
  fingerprintRoot,
  formatRecord,
  parseRecord,
  parseServeStatus,
  rootAvailability,
  type ServeDeps,
  type ServeStatus,
} from "./serve.ts";

// The front door, and the two-directional ownership precision ADR 0001 names: publishing refuses a
// root we don't own, teardown refuses one replaced out from under us. In the shell this reasoning
// lived in two `bun -e` heredocs that could only be reached by running the whole verb; here the
// verdicts are pure functions over fixture JSON.
//
// SAFETY: every `tailscale` call in this file goes through a fake Exec. Nothing here may reach the
// real tailnet — `serve`/`unserve` publish and tear down a live front door.

const OURS = "http://127.0.0.1:8787";

const status = (json: string): ServeStatus => parseServeStatus(json);

const web = (hostPort: string, path: string, proxy: string): string =>
  `"Web":{"${hostPort}":{"Handlers":{"${path}":{"Proxy":"${proxy}"}}}}`;

const tcp = (port: number, protocol: "HTTP" | "HTTPS"): string =>
  `"TCP":{"${port}":{"${protocol}":true}}`;

describe("the ownership record", () => {
  test("round-trips today's on-disk format — it is not versioned, moved or migrated", () => {
    const line = "https:443|host.ts.net:443|http://127.0.0.1:8787";
    const record = parseRecord(`${line}\n`);
    expect(record).toEqual({
      mode: "https",
      port: 443,
      hostPort: "host.ts.net:443",
      proxy: OURS,
    });
    expect(formatRecord(record)).toBe(`${line}\n`);
    // The http shape, whose listener is the bridge port rather than 443.
    expect(parseRecord("http:8787|host.ts.net:8787|http://127.0.0.1:8787")).toEqual({
      mode: "http",
      port: 8787,
      hostPort: "host.ts.net:8787",
      proxy: OURS,
    });
  });

  test("an https record on a COLLIE_SERVE_PORT listener round-trips too", () => {
    // The https arm used to accept the literal `https:443`; the port is the operator's now, and a
    // record we cannot read is a mapping we cannot tear down.
    const line = "https:8443|host.ts.net:8443|http://127.0.0.1:8787";
    const record = parseRecord(`${line}\n`);
    expect(record).toEqual({
      mode: "https",
      port: 8443,
      hostPort: "host.ts.net:8443",
      proxy: OURS,
    });
    expect(formatRecord(record)).toBe(`${line}\n`);
  });

  test("rejects every malformed shape rather than guessing at what we own", () => {
    const bad = (line: string): string => {
      try {
        parseRecord(line);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      throw new Error(`expected a refusal for: ${line}`);
    };
    // A port that is not a number is not a handler we wrote, on either protocol.
    expect(bad("https:8x|host:8x|http://127.0.0.1:8787")).toContain("invalid managed");
    expect(bad("https:|host:|http://127.0.0.1:8787")).toContain("invalid managed");
    expect(bad("ftp:21|host:21|http://127.0.0.1:8787")).toContain("invalid managed");
    expect(bad("http:|host:|http://127.0.0.1:8787")).toContain("invalid managed");
    expect(bad("http:8787|host.ts.net:8787")).toContain("invalid managed");
    expect(bad("")).toContain("invalid managed");
    // A fourth field means something wrote a record we do not understand.
    expect(bad("http:8787|host:8787|http://127.0.0.1:8787|extra")).toContain("invalid managed");
    expect(bad("http:8787|host:9999|http://127.0.0.1:8787")).toContain(
      "HostPort does not match its listener",
    );
    expect(bad("http:8787|host:8787|http://10.0.0.4:8787")).toContain("invalid managed Tailscale proxy");
    expect(bad("http:8787|host:8787|https://127.0.0.1:8787")).toContain(
      "invalid managed Tailscale proxy",
    );
  });
});

describe("fingerprintRoot — the evidence teardown checks", () => {
  test("absent when the recorded host:port has no root handler", () => {
    expect(fingerprintRoot(status("{}"), "host:443", 443)).toBe("absent");
    expect(
      fingerprintRoot(status(`{${web("host:443", "/other", OURS)}}`), "host:443", 443),
    ).toBe("absent");
  });

  test("otherwise <protocol>|proxy:<target>, with the listener deciding the protocol", () => {
    const https = `{${tcp(443, "HTTPS")},${web("host:443", "/", OURS)}}`;
    expect(fingerprintRoot(status(https), "host:443", 443)).toBe(`https|proxy:${OURS}`);
    const http = `{${tcp(8787, "HTTP")},${web("host:8787", "/", OURS)}}`;
    expect(fingerprintRoot(status(http), "host:8787", 8787)).toBe(`http|proxy:${OURS}`);
    // A root that is not a proxy at all, and a listener that is neither: never equal to a record,
    // so both refuse teardown rather than reading as ours.
    expect(fingerprintRoot(status(`{${web("host:443", "/", "")}}`), "host:443", 443)).toBe(
      "other|other",
    );
  });

  test("a malformed status throws rather than resolving to a permissive verdict", () => {
    expect(() => parseServeStatus("{not json")).toThrow();
    // Empty output is `{}`, exactly as the shell's `JSON.parse(data || "{}")` had it.
    expect(parseServeStatus("")).toEqual({});
  });
});

describe("rootAvailability — the publish-side gate", () => {
  const verdict = (json: string, port = 8787, protocol: "http" | "https" = "http"): string =>
    rootAvailability(status(json), port, protocol, OURS);

  test("free when nothing holds a root on our port", () => {
    expect(verdict("{}")).toBe("free");
    // A root on a DIFFERENT port is none of our business.
    expect(verdict(`{${web("host:9999", "/", "http://127.0.0.1:9999")}}`)).toBe("free");
    // A non-root handler on our port leaves the root free.
    expect(verdict(`{${tcp(8787, "HTTP")},${web("host:8787", "/other", OURS)}}`)).toBe("free");
  });

  test("adoptable when the root already points at us — the upgrade path, not laxness", () => {
    // Every install predating ownership tracking has Collie's own mount and NO record; refusing
    // here would brick start/restart/update on exactly the deployments that already work.
    expect(verdict(`{${tcp(8787, "HTTP")},${web("host:8787", "/", OURS)}}`)).toBe("adoptable");
    expect(
      rootAvailability(
        status(`{${tcp(443, "HTTPS")},${web("host:443", "/", OURS)}}`),
        443,
        "https",
        OURS,
      ),
    ).toBe("adoptable");
  });

  test("occupied when the root points somewhere else", () => {
    expect(
      verdict(`{${tcp(8787, "HTTP")},${web("host:8787", "/", "http://127.0.0.1:7000")}}`),
    ).toBe("occupied");
  });

  test("a foreground session is occupied at any nesting depth, and never adoptable", () => {
    // It belongs to a live process that is not us: its target matching ours proves nothing about
    // who will tear it down.
    const shallow = `{${tcp(8787, "HTTP")},"Foreground":{"sess":{${web("host:8787", "/", OURS)}}}}`;
    expect(verdict(shallow)).toBe("occupied");
    const nested = `{${tcp(8787, "HTTP")},"Foreground":{"a":{"Foreground":{"b":{${web("host:8787", "/", OURS)}}}}}}`;
    expect(verdict(nested)).toBe("occupied");
  });

  test("protocol-mismatch when the listener on that port is the opposite protocol", () => {
    expect(verdict(`{${tcp(8787, "HTTPS")},${web("host:8787", "/other", OURS)}}`)).toBe(
      "protocol-mismatch",
    );
    expect(
      rootAvailability(status(`{${tcp(443, "HTTP")}}`), 443, "https", OURS),
    ).toBe("protocol-mismatch");
    // And through a foreground session's own listener too.
    expect(verdict(`{"Foreground":{"sess":{${tcp(8787, "HTTPS")}}}}`)).toBe("protocol-mismatch");
  });
});

// ── The verbs ────────────────────────────────────────────────────────────────

interface Harness {
  deps: ServeDeps;
  io: ReturnType<typeof capture>;
  exec: FakeExec;
  files: FakeFiles;
}

function harness(
  over: Scripted & {
    env?: Record<string, string | undefined>;
    files?: Record<string, string>;
    serveMode?: "http" | "https";
    /** Serve status the fake `tailscale` answers with, before any publish. */
    serveStatus?: string;
  } = {},
): Harness {
  const io = capture();
  // Overrides first: the first matching prefix wins, so a test's own answer must outrank the
  // defaults below it.
  const answers: Scripted["answers"] = [
    ...(over.answers ?? []),
    ["tailscale status --json", { stdout: '{"Self":{"DNSName":"host.example."}}' }],
    ["tailscale serve status --json", { stdout: over.serveStatus ?? "{}" }],
  ];
  const exec = fakeExec({ ...over, answers });
  const files = fakeFiles(over.files ?? {});
  return {
    io,
    exec,
    files,
    deps: {
      ctx: context(over.env, { serveMode: over.serveMode ?? "https" }),
      io,
      exec,
      files,
    },
  };
}

describe("serve — publishing", () => {
  test("a free root is published and recorded, write-ahead", () => {
    const h = harness({ serveMode: "http" });
    expect(cmdServe(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("tailscale serve --bg --http=8787 --set-path=/ 8787");
    expect(h.files.read(HANDLER_FILE)).toBe("http:8787|host.example:8787|http://127.0.0.1:8787\n");
    expect(h.io.stdout.join("\n")).toContain("tailscale serve (http) → tailnet :8787");
  });

  test("https publishes on :443 while the proxy target stays the bridge port", () => {
    const h = harness();
    expect(cmdServe(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("tailscale serve --bg --set-path=/ 8787");
    expect(h.files.read(HANDLER_FILE)).toBe("https:443|host.example:443|http://127.0.0.1:8787\n");
    // The default install's argv is unchanged: no listener flag at all.
    expect(h.exec.calls.some((c) => c.includes("--https="))).toBe(false);
  });

  test("a foreign root refuses with exit 1, publishes nothing and records nothing", () => {
    const h = harness({
      serveMode: "http",
      serveStatus: `{${tcp(8787, "HTTP")},${web("host:8787", "/", "http://127.0.0.1:7000")}}`,
    });
    expect(cmdServe(h.deps)).toBe(EXIT.FAIL);
    expect(h.exec.calls.some((c) => c.includes("--bg"))).toBe(false);
    expect(h.files.exists(HANDLER_FILE)).toBe(false);
    expect(h.io.stderr.join("\n")).toContain("unowned root mount on :8787");
  });

  test("a pre-existing Collie root is adopted, then recorded", () => {
    const h = harness({
      serveMode: "http",
      serveStatus: `{${tcp(8787, "HTTP")},${web("host:8787", "/", OURS)}}`,
    });
    expect(cmdServe(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain("adopting the existing Collie root mount on :8787");
    expect(h.files.read(HANDLER_FILE)).toBe("http:8787|host.example:8787|http://127.0.0.1:8787\n");
  });

  test("the opposite listener protocol refuses without touching anything", () => {
    const h = harness({ serveMode: "http", serveStatus: `{${tcp(8787, "HTTPS")}}` });
    expect(cmdServe(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("opposite listener protocol");
    expect(h.files.exists(HANDLER_FILE)).toBe(false);
  });

  test("an unreadable serve status refuses; it is never a fallthrough to publishing", () => {
    const garbage = harness({ serveMode: "http", serveStatus: "{not json" });
    expect(cmdServe(garbage.deps)).toBe(EXIT.FAIL);
    expect(garbage.io.stderr.join("\n")).toContain("invalid Tailscale serve status");

    const broken = harness({
      serveMode: "http",
      answers: [["tailscale serve status --json", { code: 1 }]],
    });
    expect(cmdServe(broken.deps)).toBe(EXIT.FAIL);
    expect(broken.io.stderr.join("\n")).toContain("cannot inspect Tailscale serve status");
  });

  test("a failed publish takes the write-ahead record back down again", () => {
    const h = harness({
      serveMode: "http",
      answers: [["tailscale serve --bg", { code: 1, stderr: "access denied\n" }]],
    });
    expect(cmdServe(h.deps)).toBe(EXIT.FAIL);
    expect(h.files.exists(HANDLER_FILE)).toBe(false);
    expect(h.io.stdout.join("\n")).toContain("sudo tailscale set --operator=$USER");
    expect(h.io.stdout.join("\n")).toContain("access denied");
    // The captured output stays on disk where the shell left it.
    expect(h.files.read(`${CONFIG}/serve.out`)).toContain("access denied");
  });

  test("the https failure hint names the Headscale escape hatch", () => {
    const h = harness({ answers: [["tailscale serve --bg", { code: 1 }]] });
    expect(cmdServe(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stdout.join("\n")).toContain("COLLIE_SERVE_MODE=http");
  });

  test("a mapping we can't name is one we can't prove we own: no tailscale, no hostname", () => {
    const missing = harness({ absent: ["tailscale"] });
    expect(cmdServe(missing.deps)).toBe(EXIT.FAIL);
    expect(missing.io.stderr.join("\n")).toContain("tailscale not found");

    const nameless = harness({ answers: [["tailscale status --json", { stdout: "{}" }]] });
    expect(cmdServe(nameless.deps)).toBe(EXIT.FAIL);
    expect(nameless.io.stderr.join("\n")).toContain("untrackable root mount");
    expect(nameless.files.exists(HANDLER_FILE)).toBe(false);
  });
});

describe("serve — COLLIE_SERVE_PORT (one tailnet name, a listener port per developer)", () => {
  const AT_8443 = { COLLIE_SERVE_PORT: "8443" };

  test("the chosen port is what gets published, recorded and announced", () => {
    const h = harness({ env: AT_8443 });
    expect(cmdServe(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("tailscale serve --bg --https=8443 --set-path=/ 8787");
    expect(h.files.read(HANDLER_FILE)).toBe("https:8443|host.example:8443|http://127.0.0.1:8787\n");
    expect(h.io.stdout.join("\n")).toContain(
      "tailscale serve (https) → tailnet :8443 -> 127.0.0.1:8787",
    );
  });

  test("the availability gate is asked about 8443, not about 443", () => {
    const adopt = harness({
      env: AT_8443,
      serveStatus: `{${tcp(8443, "HTTPS")},${web("host.example:8443", "/", OURS)}}`,
    });
    expect(cmdServe(adopt.deps)).toBe(EXIT.OK);
    expect(adopt.io.stdout.join("\n")).toContain("adopting the existing Collie root mount on :8443");

    const taken = harness({
      env: AT_8443,
      serveStatus: `{${tcp(8443, "HTTPS")},${web("host.example:8443", "/", "http://127.0.0.1:7000")}}`,
    });
    expect(cmdServe(taken.deps)).toBe(EXIT.FAIL);
    expect(taken.io.stderr.join("\n")).toContain("unowned root mount on :8443");
    expect(taken.files.exists(HANDLER_FILE)).toBe(false);
  });

  test("an unusable value refuses BEFORE anything is touched — no teardown, no publish", () => {
    // A config error must have no side effect at all: tearing the live door down on the way to
    // reporting a typo would take the app offline to say "I cannot read your settings".
    const RECORD = "https:443|host.example:443|http://127.0.0.1:8787\n";
    for (const bad of ["70000", "8x", "0"]) {
      const h = harness({
        env: { COLLIE_SERVE_PORT: bad },
        serveStatus: `{${tcp(443, "HTTPS")},${web("host.example:443", "/", OURS)}}`,
        files: { [HANDLER_FILE]: RECORD },
      });
      expect(cmdServe(h.deps)).toBe(EXIT.FAIL);
      expect(h.io.stderr.join("\n")).toContain("COLLIE_SERVE_PORT");
      expect(h.exec.calls.some((c) => c.includes("off") || c.includes("--bg"))).toBe(false);
      expect(h.files.read(HANDLER_FILE)).toBe(RECORD);
    }
  });

  test("in http mode it is a refusal, not a second listener", () => {
    // There the tailnet listener already IS COLLIE_PORT; honouring both would publish on a port
    // neither setting names.
    const h = harness({ env: AT_8443, serveMode: "http" });
    expect(cmdServe(h.deps)).toBe(EXIT.FAIL);
    const err = h.io.stderr.join("\n");
    expect(err).toContain("COLLIE_SERVE_PORT");
    expect(err).toContain("COLLIE_SERVE_MODE=http");
    expect(h.exec.calls.some((c) => c.includes("--bg"))).toBe(false);
    expect(h.files.exists(HANDLER_FILE)).toBe(false);
  });

  test("teardown closes the door it opened, never :443 by default", () => {
    const h = harness({
      env: AT_8443,
      serveStatus: `{${tcp(8443, "HTTPS")},${web("host.example:8443", "/", OURS)}}`,
      files: { [HANDLER_FILE]: "https:8443|host.example:8443|http://127.0.0.1:8787\n" },
    });
    expect(cmdUnserve(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("tailscale serve --https=8443 --set-path=/ off");
    expect(h.io.stdout.join("\n")).toContain("removed Collie's managed https:8443 mapping");
    expect(h.files.exists(HANDLER_FILE)).toBe(false);
  });
});

describe("serve — a peer publishes no front door (ADR 0013, §3)", () => {
  const PEER_STORE = `${STATE}/pack-trust.json`;
  const peerOnDisk = () => ({ [PEER_STORE]: serializeTrustStore(peerStore()) });

  test("publishes nothing on a machine whose trust store says peer", () => {
    const h = harness({ files: peerOnDisk() });
    expect(cmdServe(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls.some((c) => c.includes("--bg"))).toBe(false);
    expect(h.io.stdout.join("\n")).toContain("a peer publishes no front");
    expect(h.io.stdout.join("\n")).toContain("ADR 0013");
  });

  test("it is OK, not a failure — `start` must not print a door that never should have come up", () => {
    // A peer that skipped the publish is correct, so `cmdStart`'s "the tailnet front door did not
    // come up" note must not fire. The exit code is the only thing that decides that.
    const h = harness({ files: peerOnDisk(), absent: ["tailscale"] });
    expect(cmdServe(h.deps)).toBe(EXIT.OK);
  });

  test("…and it still tears down the door this machine published as a lead", () => {
    const h = harness({
      files: { ...peerOnDisk(), [HANDLER_FILE]: "https:443|host.example:443|http://127.0.0.1:8787\n" },
      serveStatus: `{${tcp(443, "HTTPS")},${web("host.example:443", "/", OURS)}}`,
    });
    expect(cmdServe(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("tailscale serve --https=443 --set-path=/ off");
    expect(h.files.exists(HANDLER_FILE)).toBe(false);
  });

  test("a LEAD publishes exactly as it always did", () => {
    const h = harness({ files: { [PEER_STORE]: serializeTrustStore(leadStore({ peers: [member({ memberId: "nas" })] })) } });
    expect(cmdServe(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls.some((c) => c.includes("--bg"))).toBe(true);
  });

  test("no store, or a store this build cannot read, is solo — and solo publishes", () => {
    const none = harness();
    expect(cmdServe(none.deps)).toBe(EXIT.OK);
    expect(none.exec.calls.some((c) => c.includes("--bg"))).toBe(true);
    // A corrupt file must never cost a solo machine its front door.
    const corrupt = harness({ files: { [PEER_STORE]: "{ this is not a trust store" } });
    expect(cmdServe(corrupt.deps)).toBe(EXIT.OK);
    expect(corrupt.exec.calls.some((c) => c.includes("--bg"))).toBe(true);
  });
});

describe("serve — COLLIE_SKIP_SERVE (DEPLOYMENT.md Variants C/E)", () => {
  test("publishes nothing", () => {
    const h = harness({ env: { COLLIE_SKIP_SERVE: "1" } });
    expect(cmdServe(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls.some((c) => c.includes("--bg"))).toBe(false);
    expect(h.io.stdout.join("\n")).toContain("tailscale serve skipped (COLLIE_SKIP_SERVE=1)");
    expect(h.io.stdout.join("\n")).toContain("bridge is on 127.0.0.1:8787 only");
  });

  test("still tears down a mapping published before the flag was flipped", () => {
    // Skipping teardown would strand it, leaving the app reachable by a path the operator thinks
    // is closed.
    const h = harness({
      env: { COLLIE_SKIP_SERVE: "1" },
      serveStatus: `{${tcp(443, "HTTPS")},${web("host.example:443", "/", OURS)}}`,
      files: { [HANDLER_FILE]: "https:443|host.example:443|http://127.0.0.1:8787\n" },
    });
    expect(cmdServe(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("tailscale serve --https=443 --set-path=/ off");
    expect(h.files.exists(HANDLER_FILE)).toBe(false);
  });

  test("a teardown it cannot justify still fails the verb", () => {
    const h = harness({
      env: { COLLIE_SKIP_SERVE: "1" },
      serveStatus: `{${tcp(443, "HTTPS")},${web("host.example:443", "/", "http://127.0.0.1:7000")}}`,
      files: { [HANDLER_FILE]: "https:443|host.example:443|http://127.0.0.1:8787\n" },
    });
    expect(cmdServe(h.deps)).toBe(EXIT.FAIL);
    expect(h.files.exists(HANDLER_FILE)).toBe(true);
  });
});

describe("unserve — teardown", () => {
  const RECORD = "https:443|host.example:443|http://127.0.0.1:8787\n";
  const OWNED = `{${tcp(443, "HTTPS")},${web("host.example:443", "/", OURS)}}`;

  test("no record at all is success — there is nothing of ours out there", () => {
    const h = harness();
    expect(cmdUnserve(h.deps)).toBe(EXIT.OK);
    expect(h.io.stdout.join("\n")).toContain("no Collie-managed mapping recorded");
    expect(h.exec.calls.some((c) => c.includes("off"))).toBe(false);
  });

  test("a matching root is removed, scoped to the listener and the root path", () => {
    const h = harness({ serveStatus: OWNED, files: { [HANDLER_FILE]: RECORD } });
    expect(cmdUnserve(h.deps)).toBe(EXIT.OK);
    expect(h.exec.calls).toContain("tailscale serve --https=443 --set-path=/ off");
    expect(h.files.exists(HANDLER_FILE)).toBe(false);
    expect(h.io.stdout.join("\n")).toContain("removed Collie's managed https:443 mapping");
  });

  test("an absent root clears the stale record", () => {
    const h = harness({ serveStatus: "{}", files: { [HANDLER_FILE]: RECORD } });
    expect(cmdUnserve(h.deps)).toBe(EXIT.OK);
    expect(h.files.exists(HANDLER_FILE)).toBe(false);
    expect(h.io.stdout.join("\n")).toContain("cleared stale ownership state");
  });

  test("a REPLACED root is refused and the record retained — target or protocol", () => {
    const target = harness({
      serveStatus: `{${tcp(443, "HTTPS")},${web("host.example:443", "/", "http://127.0.0.1:7000")}}`,
      files: { [HANDLER_FILE]: RECORD },
    });
    expect(cmdUnserve(target.deps)).toBe(EXIT.FAIL);
    expect(target.io.stderr.join("\n")).toContain("refusing to remove the current handler");
    expect(target.files.read(HANDLER_FILE)).toBe(RECORD);
    expect(target.exec.calls.some((c) => c.includes("off"))).toBe(false);

    // Protocol-only replacement: same target, a listener someone else re-declared.
    const protocol = harness({
      serveStatus: `{${tcp(443, "HTTP")},${web("host.example:443", "/", OURS)}}`,
      files: { [HANDLER_FILE]: RECORD },
    });
    expect(cmdUnserve(protocol.deps)).toBe(EXIT.FAIL);
    expect(protocol.files.read(HANDLER_FILE)).toBe(RECORD);
  });

  test("a failed removal keeps the record for retry", () => {
    const h = harness({
      serveStatus: OWNED,
      files: { [HANDLER_FILE]: RECORD },
      answers: [["tailscale serve --https=443", { code: 1, stderr: "boom\n" }]],
    });
    expect(cmdUnserve(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("retained");
    expect(h.files.read(HANDLER_FILE)).toBe(RECORD);
  });

  test("`handler does not exist` is success — teardown is idempotent", () => {
    const h = harness({
      serveStatus: OWNED,
      files: { [HANDLER_FILE]: RECORD },
      answers: [["tailscale serve --https=443", { code: 1, stderr: "handler does not exist\n" }]],
    });
    expect(cmdUnserve(h.deps)).toBe(EXIT.OK);
    expect(h.files.exists(HANDLER_FILE)).toBe(false);
  });

  test("no tailscale: refuse and RETAIN, because ownership can't be checked", () => {
    const h = harness({ absent: ["tailscale"], files: { [HANDLER_FILE]: RECORD } });
    expect(cmdUnserve(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("retained the managed https:443 state for retry");
    expect(h.files.read(HANDLER_FILE)).toBe(RECORD);
  });

  test("an uninspectable root retains the record", () => {
    const failed = harness({
      files: { [HANDLER_FILE]: RECORD },
      answers: [["tailscale serve status --json", { code: 1 }]],
    });
    expect(cmdUnserve(failed.deps)).toBe(EXIT.FAIL);
    expect(failed.files.read(HANDLER_FILE)).toBe(RECORD);

    const garbage = harness({ serveStatus: "{not json", files: { [HANDLER_FILE]: RECORD } });
    expect(cmdUnserve(garbage.deps)).toBe(EXIT.FAIL);
    expect(garbage.io.stderr.join("\n")).toContain("cannot inspect the managed Tailscale root");
    expect(garbage.files.read(HANDLER_FILE)).toBe(RECORD);
  });

  test("a malformed record is fatal-with-retention, never a guess at what to remove", () => {
    const h = harness({ files: { [HANDLER_FILE]: "https:443|host.example:443\n" } });
    expect(cmdUnserve(h.deps)).toBe(EXIT.FAIL);
    expect(h.io.stderr.join("\n")).toContain("invalid managed Tailscale handler state");
    expect(h.files.exists(HANDLER_FILE)).toBe(true);
  });

  test("a record that cannot be deleted is an error, both after a removal and when absent", () => {
    // Dropping it would orphan a live mapping with nothing left that knows Collie owns it.
    const removed = harness({ serveStatus: OWNED, files: { [HANDLER_FILE]: RECORD } });
    removed.files.undeletable.add(HANDLER_FILE);
    expect(cmdUnserve(removed.deps)).toBe(EXIT.FAIL);
    expect(removed.io.stderr.join("\n")).toContain(
      "root was removed but ownership state could not be removed",
    );

    const absent = harness({ serveStatus: "{}", files: { [HANDLER_FILE]: RECORD } });
    absent.files.undeletable.add(HANDLER_FILE);
    expect(cmdUnserve(absent.deps)).toBe(EXIT.FAIL);
    expect(absent.io.stderr.join("\n")).toContain(
      "root is absent but ownership state could not be removed",
    );
  });
});
