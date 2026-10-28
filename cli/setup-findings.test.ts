import { describe, expect, test } from "bun:test";

import { peerStore } from "../bridge/crew/fixtures.ts";
import { serializeTrustStore, trustStorePath } from "../bridge/crew/trust-store.ts";
import { hostFor, type Host } from "../bridge/host.ts";
import { HOME, STATE, context, fakeExec, fakeFiles, fakeLinkFs, type Scripted } from "./fakes.ts";
import type { Finding } from "./finding.ts";
import { linkPath } from "./link.ts";
import {
  PATH_PROFILE_LINE,
  SETUP_CLOSING,
  setupFindings,
  setupLine,
  TAILSCALE_PROBE_MS,
  tailscaleFindings,
  type SetupDeps,
} from "./setup-findings.ts";
import { HTTPS_DISABLED_HINT, NO_CERTIFICATES_HTTP_HINT } from "./tailnet.ts";

// The setup check, through fakes only: every `tailscale` answer is scripted, and every host is
// pinned with `hostFor`, never read off the machine, so the Linux, macOS and Windows branches all run
// wherever the suite runs. No real file is touched: paths go through the fake file map.

const LINUX = hostFor("linux");
const MAC = hostFor("darwin");
const WIN = hostFor("win32");

/** `tailscale status --json` for a signed-in node with a MagicDNS name and certificates. */
const RUNNING = JSON.stringify({
  BackendState: "Running",
  Self: { DNSName: "desk.tail.ts.net." },
  CertDomains: ["desk.tail.ts.net"],
  CurrentTailnet: { MagicDNSEnabled: true },
});

interface Setup {
  host?: Host;
  env?: Record<string, string | undefined>;
  answers?: Scripted["answers"];
  absent?: string[];
  files?: Record<string, string>;
  serveMode?: "http" | "https";
  link?: boolean;
}

function deps(over: Setup = {}): SetupDeps & { exec: ReturnType<typeof fakeExec> } {
  const exec = fakeExec({
    answers: [...(over.answers ?? []), ["tailscale status --json", { stdout: RUNNING }]],
    absent: over.absent,
  });
  const built: SetupDeps & { exec: ReturnType<typeof fakeExec> } = {
    // COLLIE_MUX is set so the `mux` row answers from the setting and probes nothing.
    ctx: context({ COLLIE_MUX: "herdr", USER: "pat", ...over.env }, { serveMode: over.serveMode ?? "https" }),
    exec,
    files: fakeFiles(over.files ?? {}),
    host: over.host ?? LINUX,
  };
  if (over.link !== true) return built;
  return { ...built, link: fakeLinkFs() };
}

const row = (rows: readonly Finding[], check: string): Finding => {
  const found = rows.find((f) => f.check === check);
  if (found === undefined) throw new Error(`no ${check} row`);
  return found;
};

describe("the tailscale row", () => {
  test("not installed: a warning, and the install line follows the host", () => {
    const linux = row(tailscaleFindings(deps({ absent: ["tailscale"] })), "tailscale");
    expect(linux.status).toBe("warn");
    expect(linux.detail).toBe("Tailscale is not installed on this machine");
    expect(linux.remedy).toContain("curl -fsSL https://tailscale.com/install.sh | sh");
    expect(linux.remedy).toContain("sudo tailscale up --operator=pat");

    for (const host of [MAC, WIN]) {
      const other = row(tailscaleFindings(deps({ host, absent: ["tailscale"] })), "tailscale");
      expect(other.status).toBe("warn");
      expect(other.remedy).toContain("https://tailscale.com/download");
      expect(other.remedy).not.toContain("sudo");
    }
  });

  test("installed but the daemon does not answer, or is logged out: not signed in or not running", () => {
    const down = row(tailscaleFindings(deps({ answers: [["tailscale status --json", { code: 1 }]] })), "tailscale");
    expect(down.status).toBe("warn");
    expect(down.detail).toBe("Tailscale is installed but not signed in or not running");
    expect(down.remedy).toBe("sign in with `sudo tailscale up --operator=pat`");

    const loggedOut = tailscaleFindings(
      deps({ host: MAC, answers: [["tailscale status --json", { stdout: JSON.stringify({ BackendState: "NeedsLogin" }) }]] }),
    );
    expect(row(loggedOut, "tailscale").detail).toContain("(it reports NeedsLogin)");
    expect(row(loggedOut, "tailscale").remedy).toContain("open the Tailscale app and sign in");
    // The rows after it cannot be asked yet, and say so instead of guessing.
    expect(row(loggedOut, "tailnet-https").status).toBe("skipped");
    expect(row(loggedOut, "tailnet-https").detail).toContain("cannot be checked yet");
  });

  test("with no user name in the environment, the remedy keeps `$USER` for the shell to fill", () => {
    const d = deps({ absent: ["tailscale"], env: { USER: undefined, LOGNAME: undefined } });
    expect(row(tailscaleFindings(d), "tailscale").remedy).toContain("--operator=$USER");
  });

  test("an exit 0 with a document this build cannot read is skipped, not a verdict", () => {
    const rows = tailscaleFindings(deps({ answers: [["tailscale status --json", { stdout: "not json" }]] }));
    expect(row(rows, "tailscale").status).toBe("skipped");
  });

  test("running: ok, naming this machine", () => {
    const f = row(tailscaleFindings(deps()), "tailscale");
    expect(f.status).toBe("ok");
    expect(f.detail).toContain("desk.tail.ts.net");
    expect(f.remedy).toBeNull();
  });
});

describe("the tailnet-https row", () => {
  /** The fields of `tailscale status --json` these cases vary. */
  interface StatusDoc {
    BackendState?: string;
    Self?: { DNSName?: string };
    CertDomains?: string[] | string;
    CurrentTailnet?: { MagicDNSEnabled?: boolean };
  }
  const status = (doc: StatusDoc): Scripted["answers"] => [["tailscale status --json", { stdout: JSON.stringify(doc) }]];

  test("no MagicDNS name, or MagicDNS switched off, is a warning naming the DNS page", () => {
    const noName = row(tailscaleFindings(deps({ answers: status({ BackendState: "Running", CertDomains: ["x"] }) })), "tailnet-https");
    expect(noName.status).toBe("warn");
    expect(noName.detail).toBe("MagicDNS is off, so this machine has no tailnet name");
    expect(noName.remedy).toContain("DNS page");

    const off = status({
      BackendState: "Running",
      Self: { DNSName: "desk.tail.ts.net." },
      CertDomains: ["desk.tail.ts.net"],
      CurrentTailnet: { MagicDNSEnabled: false },
    });
    expect(row(tailscaleFindings(deps({ answers: off })), "tailnet-https").status).toBe("warn");
  });

  test("no certificates under https: a warning, never an error, with the Headscale way out", () => {
    const noCerts = status({ BackendState: "Running", Self: { DNSName: "desk.tail.ts.net." } });
    const https = row(tailscaleFindings(deps({ answers: noCerts })), "tailnet-https");
    expect(https.status).toBe("warn");
    expect(https.detail).toBe("HTTPS certificates are off for your tailnet");
    expect(https.remedy).toBe(`${HTTPS_DISABLED_HINT}; ${NO_CERTIFICATES_HTTP_HINT}`);
    expect(https.remedy).toContain("on Headscale or a tailnet without certificates, set COLLIE_SERVE_MODE=http");
  });

  test("http mode chosen: skipped, whatever the certificates, so `start` prints no line for it", () => {
    for (const doc of [
      { BackendState: "Running", Self: { DNSName: "desk.tail.ts.net." } },
      { BackendState: "Running", Self: { DNSName: "desk.tail.ts.net." }, CertDomains: ["desk.tail.ts.net"] },
    ]) {
      const f = row(tailscaleFindings(deps({ answers: status(doc), serveMode: "http" })), "tailnet-https");
      expect(f.status).toBe("skipped");
      expect(f.detail).toBe(
        "http mode chosen, so no certificate is needed; the phone cannot install Collie to the home screen over http",
      );
    }
  });

  test("no Tailscale row is ever an error: the update gate reads doctor errors", () => {
    const sick: Setup[] = [
      { absent: ["tailscale"] },
      { answers: [["tailscale status --json", { code: 1 }]] },
      { answers: status({ BackendState: "Running", CertDomains: ["x"] }) },
      { answers: status({ BackendState: "Running", Self: { DNSName: "desk.tail.ts.net." } }) },
      { answers: [["tailscale serve status", { code: 1, stderr: "Access denied: serve config denied\n" }]] },
    ];
    for (const over of sick) {
      for (const host of [LINUX, MAC, WIN]) {
        expect(tailscaleFindings(deps({ ...over, host })).filter((f) => f.status === "error")).toEqual([]);
      }
    }
  });

  test("a certificate list it cannot read is skipped", () => {
    const odd = status({ BackendState: "Running", Self: { DNSName: "desk.tail.ts.net." }, CertDomains: "desk" });
    const f = row(tailscaleFindings(deps({ answers: odd })), "tailnet-https");
    expect(f.status).toBe("skipped");
    expect(f.detail).toBe("could not read the certificate setting");
  });

  test("a name and certificates: ok", () => {
    const f = row(tailscaleFindings(deps({ host: WIN })), "tailnet-https");
    expect(f.status).toBe("ok");
    expect(f.detail).toContain("HTTPS certificates on");
  });
});

describe("the tailscale-operator row", () => {
  test("Linux only: macOS and Windows have no operator setting, so there is no row", () => {
    expect(tailscaleFindings(deps({ host: MAC })).map((f) => f.check)).toEqual(["tailscale", "tailnet-https"]);
    expect(tailscaleFindings(deps({ host: WIN })).map((f) => f.check)).toEqual(["tailscale", "tailnet-https"]);
    expect(tailscaleFindings(deps()).map((f) => f.check)).toEqual(["tailscale", "tailnet-https", "tailscale-operator"]);
  });

  test("an Access denied from `tailscale serve status` is a warning with the operator command for this user", () => {
    const d = deps({ answers: [["tailscale serve status", { code: 1, stderr: "Access denied: serve config denied\n" }]] });
    const f = row(tailscaleFindings(d), "tailscale-operator");
    expect(f.status).toBe("warn");
    expect(f.detail).toBe("your user may not run tailscale serve");
    expect(f.remedy).toBe("`sudo tailscale set --operator=pat`");
  });

  test("another failure of `serve status` is skipped with what it said", () => {
    const d = deps({ answers: [["tailscale serve status", { code: 1, stderr: "something else\n" }]] });
    const f = row(tailscaleFindings(d), "tailscale-operator");
    expect(f.status).toBe("skipped");
    expect(f.detail).toContain("something else");
  });

  test("the prefs name another operator, or none: a warning, because the read alone proves nothing", () => {
    const other = deps({ answers: [["tailscale debug prefs", { stdout: JSON.stringify({ OperatorUser: "alex" }) }]] });
    const f = row(tailscaleFindings(other), "tailscale-operator");
    expect(f.status).toBe("warn");
    expect(f.detail).toContain("the Tailscale operator is alex, not pat");
    expect(f.remedy).toBe("`sudo tailscale set --operator=pat`");

    const none = deps({ answers: [["tailscale debug prefs", { stdout: JSON.stringify({ OperatorUser: "" }) }]] });
    expect(row(tailscaleFindings(none), "tailscale-operator").detail).toContain("no Tailscale operator is set");
  });

  test("this user is the operator, or root: ok", () => {
    const own = deps({ answers: [["tailscale debug prefs", { stdout: JSON.stringify({ OperatorUser: "pat" }) }]] });
    expect(row(tailscaleFindings(own), "tailscale-operator")).toEqual({
      check: "tailscale-operator",
      status: "ok",
      detail: "pat is the Tailscale operator",
      remedy: null,
    });
    const root = deps({ env: { USER: "root" } });
    expect(row(tailscaleFindings(root), "tailscale-operator").status).toBe("ok");
    // Root asks nothing more than the status read.
    expect(root.exec.calls).toEqual(["tailscale status --json"]);
  });
});

describe("when Collie does not use Tailscale", () => {
  test("COLLIE_SKIP_SERVE=1 skips every Tailscale row and asks Tailscale nothing", () => {
    const d = deps({ env: { COLLIE_SKIP_SERVE: "1" }, absent: ["tailscale"] });
    const rows = tailscaleFindings(d);
    expect(rows.map((f) => f.status)).toEqual(["skipped", "skipped", "skipped"]);
    expect(rows[0]?.detail).toContain("COLLIE_SKIP_SERVE=1");
    expect(d.exec.calls).toEqual([]);
  });

  test("a crew peer on disk skips them too: a peer publishes no front door", () => {
    const d = deps({ host: WIN, files: { [trustStorePath(STATE)]: serializeTrustStore(peerStore()) }, absent: ["tailscale"] });
    const rows = tailscaleFindings(d);
    expect(rows.map((f) => f.status)).toEqual(["skipped", "skipped"]);
    expect(rows[0]?.detail).toContain("crew peer");
    expect(d.exec.calls).toEqual([]);
  });
});

describe("every tailscale call is bounded and never prompts", () => {
  test("each call is a capture with the probe bound; nothing runs on the operator's terminal", () => {
    const d = deps({ answers: [["tailscale debug prefs", { stdout: "{}" }]] });
    tailscaleFindings(d);
    const tailscaleCalls = d.exec.calls.filter((c) => c.startsWith("tailscale"));
    expect(tailscaleCalls).toEqual(["tailscale status --json", "tailscale serve status", "tailscale debug prefs"]);
    expect(d.exec.timeouts).toEqual(tailscaleCalls.map((call) => ({ call, ms: TAILSCALE_PROBE_MS })));
  });
});

describe("the path-link row", () => {
  test("a fresh POSIX install with no `collie` on PATH warns, with the line install.sh prints", () => {
    const d = deps({ link: true, env: { PATH: "/usr/bin" } });
    const f = row(setupFindings(d), "path-link");
    expect(f.status).toBe("warn");
    expect(f.detail).toContain("no `collie` is on PATH");
    expect(f.remedy).toBe(`run \`collie link\`, then add this line to ~/.zshrc or ~/.bashrc, then open a new terminal: ${PATH_PROFILE_LINE}`);
    expect(PATH_PROFILE_LINE).toBe('export PATH="$HOME/.local/bin:$PATH"');
  });

  test("with ~/.local/bin already on PATH the fix is only `collie link`", () => {
    const d = deps({ host: MAC, link: true, env: { PATH: `/usr/bin:${HOME}/.local/bin` } });
    expect(row(setupFindings(d), "path-link").remedy).toBe("run `collie link`");
  });

  test("a `collie` on PATH from elsewhere (a package) is fine unlinked", () => {
    const d = deps({ link: true, env: { PATH: "/usr/bin" }, files: { "/usr/bin/collie": "" } });
    expect(row(setupFindings(d), "path-link").status).toBe("ok");
  });

  test("Windows: no `collie.exe` on the user PATH warns and names the folder; one there is fine", () => {
    const missing = deps({ host: WIN, link: true, env: { Path: "C:\\Windows\\System32" } });
    const f = row(setupFindings(missing), "path-link");
    expect(f.status).toBe("warn");
    expect(f.remedy).toContain("user PATH");
    expect(f.remedy).not.toContain("~/.zshrc");

    const bin = "C:\\Users\\pat\\collie\\current\\bin";
    const present = deps({
      host: WIN,
      link: true,
      env: { Path: `C:\\Windows\\System32;${bin}` },
      files: { [`${bin}\\collie.exe`]: "" },
    });
    expect(row(setupFindings(present), "path-link").status).toBe("ok");
  });

  test("linked here but ~/.local/bin is off PATH: the profile line, not a bare directory", () => {
    const d = deps({ env: { PATH: "/usr/bin" } });
    const linked: SetupDeps = {
      ...d,
      link: fakeLinkFs({ [linkPath(HOME)]: { kind: "symlink", target: "/opt/collie/bin/collie" } }),
    };
    const f = row(setupFindings(linked), "path-link");
    expect(f.status).toBe("warn");
    expect(f.remedy).toContain(PATH_PROFILE_LINE);
  });

  test("no link reader, no path-link row", () => {
    expect(setupFindings(deps()).map((f) => f.check)).not.toContain("path-link");
  });
});

describe("the whole check", () => {
  test("the rows come in start's order: Tailscale, then mux, then path-link", () => {
    expect(setupFindings(deps({ link: true, env: { PATH: "/usr/bin" }, files: { "/usr/bin/collie": "" } })).map((f) => f.check)).toEqual([
      "tailscale",
      "tailnet-https",
      "tailscale-operator",
      "mux",
      "path-link",
    ]);
  });

  test("the mux row is doctor's own: several running and no COLLIE_MUX is an error naming the setting", () => {
    const d = deps({
      env: { COLLIE_MUX: undefined },
      files: { "/home/pat/.config/herdr/herdr.sock": "", "/usr/bin/tmux": "" },
      answers: [["/usr/bin/tmux list-sessions", { stdout: "work\n" }]],
    });
    const f = row(setupFindings(d), "mux");
    expect(f.status).toBe("error");
    expect(`${f.detail} ${f.remedy ?? ""}`).toContain("COLLIE_MUX");
  });

  test("a printed line is the detail, an arrow and the remedy; the closing sentence is fixed", () => {
    const f = row(tailscaleFindings(deps({ absent: ["tailscale"], host: WIN })), "tailscale");
    expect(setupLine(f)).toBe(
      "setup: Tailscale is not installed on this machine → install Tailscale from https://tailscale.com/download, sign in, then run `collie start` again",
    );
    expect(SETUP_CLOSING).toBe("Fix these, then run collie start again. collie doctor repeats this check.");
  });
});
