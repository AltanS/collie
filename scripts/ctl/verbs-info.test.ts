import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import {
  logs,
  qr,
  status,
  url,
  version,
  type CtlCtx,
  type InfoDeps,
} from "./verbs-info.ts";

const CTX: CtlCtx = {
  configDir: "/cfg",
  stateDir: "/state",
  socketPath: "/socket",
};

const serveFile = join(CTX.configDir, "tailscale-managed-handler");
const logFile = join(CTX.stateDir, "collie.log");

function makeDeps(files: Record<string, string> = {}, extra: Partial<InfoDeps> = {}): InfoDeps {
  const entries = new Map(Object.entries(files));
  return {
    exists: async (path: string) => entries.has(path),
    readText: async (path: string) => {
      const text = entries.get(path);
      if (text === undefined) throw new Error(`ENOENT: ${path}`);
      return text;
    },
    ...extra,
  };
}

// The info verbs are mostly pure routing: the hard part is which state to read, not how to print it.
// These tests pin the routing against injected stubs so nothing needs the real filesystem, service
// manager or qr renderer.

describe("version", () => {
  test("returns the version string parsed from package.json via the injected reader", async () => {
    const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const packageJson = await Bun.file(packageJsonPath).text();
    const expected = (JSON.parse(packageJson) as { version: string }).version;
    expect(await version({ readPackageJson: async () => packageJson })).toBe(expected);
  });
});

describe("status", () => {
  test("renders running when the backend is active and the socket exists", async () => {
    let isActiveCalls = 0;
    const out = await status(
      CTX,
      makeDeps(
        {
          [CTX.socketPath]: "socket-present",
          [serveFile]: "http:8787|host.example:8787|http://127.0.0.1:8787\n",
        },
        {
          backend: {
            kind: "windows",
            isActive: async () => {
              isActiveCalls += 1;
              return true;
            },
          },
        },
      ),
    );
    expect(isActiveCalls).toBe(1);
    expect(out).toContain("running");
    expect(out).toContain("backend: active (windows)");
    expect(out).toContain("socket: present");
    expect(out).toContain("serve: http://host.example:8787 -> http://127.0.0.1:8787");
  });

  test("renders stopped when the backend is present but the socket is missing", async () => {
    const out = await status(
      CTX,
      makeDeps(
        {},
        {
          backend: {
            kind: "systemd",
            isActive: async () => false,
          },
        },
      ),
    );
    expect(out).toContain("stopped");
    expect(out).toContain("backend: inactive (systemd)");
    expect(out).toContain("socket: missing");
    expect(out).toContain("serve: none");
  });

  test("renders no-backend when no backend is injected", async () => {
    const out = await status(CTX, makeDeps());
    expect(out).toContain("no-backend");
    expect(out).toContain("backend: unavailable");
    expect(out).toContain("socket: missing");
    expect(out).toContain("serve: none");
  });
});

describe("url", () => {
  test("reconstructs an http URL from the serve mapping file", async () => {
    const out = await url(
      CTX,
      makeDeps({ [serveFile]: "http:8787|host.example:8787|http://127.0.0.1:8787\n" }),
    );
    expect(out).toBe("http://host.example:8787");
  });

  test("reconstructs an https URL and drops the default :443 port", async () => {
    const out = await url(
      CTX,
      makeDeps({ [serveFile]: "https:443|host.example:443|http://127.0.0.1:8787\n" }),
    );
    expect(out).toBe("https://host.example");
  });
});

describe("logs", () => {
  test("tails stateDir/collie.log on the windows backend", async () => {
    const tailCalls: string[] = [];
    const out = await logs(
      CTX,
      {
        backend: {
          kind: "windows",
          isActive: async () => true,
          logsCmd: async () => {
            throw new Error("should not delegate windows logs to logsCmd");
          },
        },
        tailFile: async (path: string, lines: number) => {
          tailCalls.push(`${path}:${lines}`);
          return "tail-output";
        },
      },
      12,
    );
    expect(out).toBe("tail-output");
    expect(tailCalls).toEqual([`${logFile}:12`]);
  });

  test("delegates to the backend logs command on posix backends", async () => {
    const out = await logs(
      CTX,
      {
        backend: {
          kind: "launchd",
          isActive: async () => true,
          logsCmd: async (lines: number) => `journalctl:${lines}`,
        },
        tailFile: async () => {
          throw new Error("should not tail stateDir/collie.log on posix backends");
        },
      },
      7,
    );
    expect(out).toBe("journalctl:7");
  });
});

describe("qr", () => {
  test("prefers a provided public URL and hands it to the renderer", async () => {
    let seen = "";
    const out = await qr(CTX, {
      publicUrl: "https://collie.example.com",
      readText: async () => {
        throw new Error("should not inspect the serve mapping when publicUrl is provided");
      },
      renderQr: async (urlValue: string) => {
        seen = urlValue;
        return `QR:${urlValue}`;
      },
    });
    expect(seen).toBe("https://collie.example.com");
    expect(out).toBe("QR:https://collie.example.com");
  });
});
