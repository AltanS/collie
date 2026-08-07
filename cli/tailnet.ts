import type { ServeMode } from "./context.ts";
import type { Exec } from "./sys.ts";

// `tailscale status --json` → this host's name. The shell piped that JSON through an inline
// interpreter one-liner (scripts/collie-ctl.sh:176-179) — exactly the runtime interpreter
// dependency the compiled binary exists to remove — so the parse moves in-process.

/** `Self.DNSName` with its trailing dot stripped, or null when the JSON says nothing useful. */
export function selfDnsName(statusJson: string): string | null {
  try {
    const data = JSON.parse(statusJson) as { Self?: { DNSName?: unknown } };
    const name = data.Self?.DNSName;
    if (typeof name !== "string") return null;
    const trimmed = name.replace(/\.$/, "").trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * The URL to open. `https://<name>` in https mode (tailscale terminates TLS on 443),
 * `http://<name>:<port>` in http mode, and a loopback URL that SAYS why when the tailnet name is
 * unavailable — an operator on Headscale reads that line to find out their setup isn't published.
 */
export function bridgeUrlFrom(name: string | null, mode: ServeMode, port: number): string {
  if (name === null) return `http://127.0.0.1:${port} (Tailscale name unavailable)`;
  return mode === "http" ? `http://${name}:${port}` : `https://${name}`;
}

/** {@link selfDnsName} over a live `tailscale status --json`. A missing CLI reads as no name. */
export function tailnetName(exec: Exec): string | null {
  const r = exec.capture("tailscale", ["status", "--json"]);
  if (!r.found || r.code !== 0) return null;
  return selfDnsName(r.stdout);
}

export function bridgeUrl(exec: Exec, mode: ServeMode, port: number): string {
  return bridgeUrlFrom(tailnetName(exec), mode, port);
}
