import { bindIsWildcard } from "../bridge/crew/config.ts";
import { resolveBridgeHost } from "../bridge/config.ts";
import type { CrewFetch } from "../bridge/crew/peer-client.ts";
import { localAuthHeader, readLocalSecret } from "../bridge/local-secret.ts";
import type { CliContext } from "./context.ts";
import type { SnapshotRead } from "./history.ts";
import type { Files } from "./sys.ts";

// One read of THIS bridge's own `/api/snapshot`, for the verbs that run beside the bridge: `collie
// doctor` (its history and restart checks), `collie status` (the sessions block of the census) and,
// `collie sessions`. They all had the same four questions to answer, so they ask one function:
// where did the bridge bind, what credential does a local read carry, how long may it take, and what
// does a silence look like against a refusal.

/** What the read needs from a verb: the context for the bind and the state dir, a file read, a fetch. */
export interface SnapshotReadDeps {
  readonly ctx: Pick<CliContext, "env" | "port" | "stateDir">;
  readonly files: Pick<Files, "read">;
  readonly fetch: CrewFetch;
}

/** Long enough for a busy loopback bridge, short enough that a wedged one does not hold a verb. */
export const SNAPSHOT_BUDGET_MS = 3000;

/**
 * The `Authorization` header a read from this host carries: the bridge's local read credential
 * (`<stateDir>/local-secret`, `bridge/local-secret.ts`), and nothing else. With no file on disk (the
 * bridge is down, or older than the credential) the object is empty and the bridge answers as it
 * would any caller with no token. It is never a `Tailscale-User-Login`: that header is an identity
 * claim a caller makes about itself, and this verb is not entitled to make one.
 */
export function localReadHeaders(deps: Pick<SnapshotReadDeps, "ctx" | "files">): Record<string, string> {
  return localAuthHeader(readLocalSecret(deps.ctx.stateDir, (p) => deps.files.read(p)));
}

/**
 * This bridge's own `/api/snapshot`, as text: its body, its refusal, or silence.
 *
 * The address is the one the bridge BOUND (`resolveBridgeHost`, as `status` probes it), not a
 * hard-wired loopback: a peer sets `COLLIE_HOST` to its tailnet address and never answers on
 * 127.0.0.1, and dialling loopback there would report "the bridge is down" against a bridge that is
 * up. A wildcard bind answers everywhere, so loopback is the right dial for it.
 *
 * A READ, and the only route these verbs ask their own bridge for. `extraHeaders` is for the callers
 * (`doctor`, issue #238, and `sessions`) that also send their configured login. `query` is the
 * query string without its `?` (`collie sessions` asks `sessions=all`).
 */
export async function readOwnSnapshot(
  deps: SnapshotReadDeps,
  options: { readonly budgetMs?: number; readonly extraHeaders?: Record<string, string>; readonly query?: string } = {},
): Promise<SnapshotRead> {
  const host = resolveBridgeHost(deps.ctx.env);
  const dialled = bindIsWildcard(host) ? "127.0.0.1" : host;
  const bracketed = dialled.includes(":") && !dialled.startsWith("[") ? `[${dialled}]` : dialled;
  const query = options.query === undefined || options.query === "" ? "" : `?${options.query}`;
  try {
    const answer = await deps.fetch(`http://${bracketed}:${String(deps.ctx.port)}/api/snapshot${query}`, {
      signal: AbortSignal.timeout(options.budgetMs ?? SNAPSHOT_BUDGET_MS),
      headers: { ...options.extraHeaders, ...localReadHeaders(deps) },
    });
    if (answer.ok) return { kind: "body", text: await answer.text() };
    return { kind: "refused", status: answer.status };
  } catch {
    return { kind: "silent" };
  }
}
