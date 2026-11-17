import { randomUUID } from "node:crypto";

import { asJsonBoolean, asJsonObject, asJsonString, parseJsonObject } from "../web/src/lib/json.ts";
import { isTrickId, TRICKS_WINDOWS_LINE } from "../web/src/lib/tricks/schema.ts";
import { walkySocketPath } from "../bridge/walky/socket.ts";
import { readEnvMarkers } from "./beacon.ts";
import { holdSocketSafe } from "./hold.ts";
import { EXIT } from "./io.ts";
import { shown, type PaneKind, type WalkyDeps } from "./walky.ts";

// `collie trick set <id> <key> <value>` (contract 3): one of a trick's settings, from the person's terminal.
// It writes through the running bridge, over this instance's own walky socket (`trick.set`), so the write
// takes the same path as the phone's: the field's rule, a request id, one audit line with the trick and the
// key and never the value, and one run of the trick when the value moved. It never writes `values.json`
// itself, and it never prints the value back: a terminal may be recorded.
//
// It refuses in a pane where the running bridge sees an agent, twice: here, from the bridge's `pane` answer
// (as `collie trick on` does), and on the bridge, which refuses `trick.set` from an agent's pane too. A speed
// bump, not a wall: a process that strips the markers gets past both. The user account is the boundary.

export interface TrickSetDeps extends WalkyDeps {
  /** What the local bridge says of the pane this runs in (cli/walky.ts `askPaneKind`). None: not asked. */
  paneKind?: () => Promise<PaneKind>;
  /** The request id of the write. Default a fresh UUID; a test passes a fixed one. */
  mintRequestId?: () => string;
}

const USAGE = "usage: collie trick set <id> <key> <value>   (or --clear for the default; refused inside an agent's pane)";

/** The lines `trick set` refuses with inside an agent's pane. */
export function setAgentPaneRefusal(id: string): string[] {
  return [
    "error: a trick's settings are your person's to set, and this runs in a pane where an agent works.",
    `Tell your operator which setting of ${id} to change. They set it on the phone (the trick's About sheet, Settings) or with collie trick set in a terminal.`,
  ];
}

/** What a run of the verb read off its arguments, or why it cannot run. */
type SetArgs = { id: string; key: string; text: string | null } | { error: string };

export function parseSetArgs(args: readonly string[]): SetArgs {
  const clear = args.includes("--clear");
  const words = args.filter((arg) => arg !== "--clear");
  const [id, key, ...rest] = words;
  if (id === undefined || !isTrickId(id)) return { error: "the first word is the trick's id: 1 to 32 of a-z, 0-9 and -" };
  if (key === undefined || !isTrickId(key)) return { error: "the second word is the setting's key, as its trick.toml names it" };
  if (clear) return rest.length === 0 ? { id, key, text: null } : { error: "--clear takes no value" };
  // The value is one argument; quote it in the shell when it holds spaces.
  if (rest.length !== 1 || rest[0] === undefined) return { error: "give the value as one argument (quote it when it holds spaces), or --clear" };
  return { id, key, text: rest[0] };
}

/** The exit code of a bridge's refusal code. */
function exitOf(code: string): number {
  if (code === "not-here" || code === "windows") return EXIT.STATE;
  if (code === "write-failed") return EXIT.FAIL;
  return EXIT.REFUSED;
}

export async function cmdTrickSet(deps: TrickSetDeps, args: readonly string[]): Promise<number> {
  if (deps.platform === "win32") {
    deps.io.err(`error: ${TRICKS_WINDOWS_LINE}`);
    return EXIT.FAIL;
  }
  const read = parseSetArgs(args);
  if ("error" in read) {
    deps.io.err(`error: ${read.error}`);
    deps.io.err(USAGE);
    return EXIT.USAGE;
  }
  if (readEnvMarkers(deps.ctx.env).length > 0 && deps.paneKind !== undefined && (await deps.paneKind().catch(() => "unknown" as const)) === "agent") {
    for (const line of setAgentPaneRefusal(read.id)) deps.io.err(line);
    return EXIT.REFUSED;
  }
  // This instance's own bridge, and no other: the trick and its values are this instance's.
  const path = walkySocketPath(deps.ctx.stateDir);
  const requestId = (deps.mintRequestId ?? randomUUID)();
  const line = `${JSON.stringify({ v: 1, op: "trick.set", markers: readEnvMarkers(deps.ctx.env), trick: read.id, key: read.key, requestId, text: read.text })}\n`;
  const raw = holdSocketSafe(deps, path) ? await deps.ask(path, line).catch(() => null) : null;
  const answer = raw === null ? undefined : parseJsonObject(raw);
  if (answer === undefined) {
    deps.io.err("error: no running Collie bridge answers on this machine. Start Collie, then set it again.");
    return EXIT.UNREACHABLE;
  }
  if (answer.ok !== true) {
    const error = asJsonString(answer.error) ?? "failed";
    if (answer.trickSet !== true) {
      deps.io.err(`error: this Collie bridge cannot set a trick's settings yet (${shown(error)}). Update Collie, or set it on the phone.`);
      return EXIT.STATE;
    }
    const code = asJsonString(answer.code) ?? "failed";
    if (code === "person_only") {
      for (const text of setAgentPaneRefusal(read.id)) deps.io.err(text);
      return EXIT.REFUSED;
    }
    deps.io.err(`error: ${shown(error)}`);
    return exitOf(code);
  }
  const changed = asJsonBoolean(asJsonObject(answer.trickSet)?.changed) === true;
  if (!changed) deps.io.out(`${read.key} of ${read.id} is unchanged.`);
  else if (read.text === null) deps.io.out(`Cleared ${read.key} of ${read.id}: it reads its default now. A trick that is on runs once with it.`);
  else deps.io.out(`Saved ${read.key} of ${read.id}. A trick that is on runs once with it.`);
  return EXIT.OK;
}
