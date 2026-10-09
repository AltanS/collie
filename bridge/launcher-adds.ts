import type { AuditLog } from "./audit.ts";
import { apiError } from "./error-codes.ts";
import { HARNESS_LAUNCHES, harnessLaunch } from "./harness-launch.ts";
import type { JsonObject, JsonValue } from "./json.ts";
import {
  buildRecipe,
  cleanLauncherText,
  MAX_COMMAND_CHARS,
  MAX_LABEL_CHARS,
  recipeOptions,
  scanNoPrompts,
  type TextProblem,
} from "./launcher-recipes.ts";
import { MAX_ADDED, type AddedLauncher, type AddedLauncherSurface } from "./launchers-added.ts";
import type { LauncherSwitches } from "./operator-launchers.ts";
import type {
  AddedLauncherResponse,
  AddedOffWire,
  HarnessInfo,
  Launcher,
  LauncherItem,
  LaunchersAdding,
  RecipeWire,
} from "./types.ts";
import { isRequestId } from "./worktree-receipts.ts";

// ── The launch allowlist, merged, and the three routes that change a phone's rows (ADR 0094) ────
//
// THE ALLOWLIST IS THREE LISTS, MERGED AT READ TIME, NEVER STORED MERGED:
//   1. the agents Collie starts by id (bridge/harness-launch.ts) — `harness` in a launch body, not here;
//   2. the operator's rows, `launchers.toml`;
//   3. the rows phones added on this machine, `launchers-added.json`, as far as the operator's
//      `[phone]` switches allow them today.
// An operator row wins over an added row with the same line: the operator's label and folder are the
// ones that count, and the added row is simply not listed twice. A switch turned off takes the rows it
// covers out of the allowlist at once, without deleting them.
//
// THE ROUTES are pure here: each takes the parsed body and what it needs, and answers a status and a
// body. bridge/server.ts owns the gate, the `?host=` forward and the JSON response, exactly as for
// the folder routes, so this file reads no request and writes no response.

/** What the merge reads. */
export interface LauncherSources {
  operator: () => Promise<Launcher[]>;
  added: AddedLauncherSurface;
  switches: () => Promise<LauncherSwitches>;
}

/** The merged view: what may start, what is held back and why, and the switches it was read under. */
export interface MergedLaunchers {
  rows: Launcher[];
  off: AddedOffWire[];
  stored: AddedLauncher[];
  switches: LauncherSwitches;
}

/** An operator row as the wire carries it: its source, its kind, and the no-prompts mark. */
export function operatorWire(row: Launcher): Launcher {
  const out: Launcher = { ...row, source: "operator", kind: row.harness === undefined ? "command" : "agent" };
  out.noPrompts = row.noPrompts === true || scanNoPrompts(row.command);
  return out;
}

/** An added row as the wire carries it. The device label is the operator's own name for a phone. */
export function addedWire(row: AddedLauncher): Launcher {
  const out: Launcher = {
    command: row.command,
    label: row.label,
    source: "added",
    id: row.id,
    kind: row.kind,
    noPrompts: row.noPrompts,
    addedBy: row.device,
    addedAt: row.at,
    addedAs: row.source,
  };
  if (row.harness !== undefined) out.harness = row.harness;
  return out;
}

/** The three lists into one, operator first. Pure. */
export function mergeLaunchers(operator: readonly Launcher[], added: readonly AddedLauncher[], switches: LauncherSwitches): MergedLaunchers {
  const rows = operator.map(operatorWire);
  const off: AddedOffWire[] = [];
  for (const row of added) {
    const reason = !switches.adds ? "adds_off" : row.source === "text" && !switches.freeText ? "free_text_off" : null;
    if (reason !== null) {
      const item: AddedOffWire = { id: row.id, label: row.label, command: row.command, kind: row.kind, reason };
      if (row.harness !== undefined) item.harness = row.harness;
      off.push(item);
      continue;
    }
    if (rows.some((r) => r.command === row.command)) continue;
    rows.push(addedWire(row));
  }
  return { rows, off, stored: [...added], switches };
}

/** Read and merge the three lists. */
export async function readMerged(sources: LauncherSources): Promise<MergedLaunchers> {
  const [operator, added, switches] = await Promise.all([sources.operator(), sources.added.list(), sources.switches()]);
  return mergeLaunchers(operator, added, switches);
}

/** Every harness Collie starts, with the options its table lists. Pure. */
export function recipesWire(): RecipeWire[] {
  return HARNESS_LAUNCHES.map((h) => ({
    harness: h.id,
    label: h.label,
    binary: h.binary,
    options: recipeOptions(h.id).map((o) => {
      const wire: RecipeWire["options"][number] = { id: o.id, label: o.label, args: o.args };
      if (o.group !== undefined) wire.group = o.group;
      if (o.noPrompts === true) wire.noPrompts = true;
      return wire;
    }),
  }));
}

/** The `adding` block of `GET /api/launchers`. */
export function addingBody(merged: MergedLaunchers, file: string): LaunchersAdding {
  return {
    adds: merged.switches.adds,
    freeText: merged.switches.freeText,
    file,
    count: merged.stored.length,
    max: MAX_ADDED,
    recipes: recipesWire(),
    off: merged.off,
  };
}

/** One operator or added row as a New-page item. */
function rowItem(row: Launcher, reason?: LauncherItem["reason"]): LauncherItem {
  const agent = row.kind === "agent";
  const item: LauncherItem = {
    key: `row:${row.command}`,
    start: { command: row.command },
    group: agent ? "agents" : "commands",
    label: row.label,
    command: row.command,
    source: row.source === "added" ? "added" : "operator",
    noPrompts: row.noPrompts === true,
    branch: agent,
    available: reason === undefined,
  };
  if (row.harness !== undefined) item.harness = row.harness;
  if (row.cwd !== undefined) item.cwd = row.cwd;
  if (reason !== undefined) item.reason = reason;
  if (row.id !== undefined) item.id = row.id;
  if (row.addedBy !== undefined) item.addedBy = row.addedBy;
  if (row.addedAt !== undefined) item.addedAt = row.addedAt;
  if (row.addedAs !== undefined) item.addedAs = row.addedAs;
  return item;
}

/**
 * The New page's one list for this machine: the agents Collie starts, then agent rows, then the
 * shell, then command rows, each with whether it starts here now and the reason code when it does not.
 * `harnesses` is absent when the route was built without a probe: then no built-in agent is listed.
 */
export function launcherItems(harnesses: readonly HarnessInfo[] | undefined, merged: MergedLaunchers): LauncherItem[] {
  const agents: LauncherItem[] = [];
  const commands: LauncherItem[] = [];
  for (const h of harnesses ?? []) {
    const item: LauncherItem = {
      key: `harness:${h.id}`,
      start: { harness: h.id },
      group: "agents",
      label: h.label,
      harness: h.id,
      source: "builtin",
      noPrompts: false,
      branch: true,
      available: h.found,
    };
    if (!h.found) item.reason = "not_found";
    agents.push(item);
  }
  for (const row of merged.rows) (row.kind === "agent" ? agents : commands).push(rowItem(row));
  for (const off of merged.off) {
    const stored = merged.stored.find((r) => r.id === off.id);
    if (stored === undefined) continue;
    (stored.kind === "agent" ? agents : commands).push(rowItem(addedWire(stored), off.reason));
  }
  const shell: LauncherItem = {
    key: "shell",
    start: { shell: true },
    group: "commands",
    label: "Shell",
    source: "builtin",
    noPrompts: false,
    branch: true,
    available: true,
  };
  return [...agents, shell, ...commands];
}

// ── The routes ─────────────────────────────────────────────────────────────────────────────────

/** A route's answer, for bridge/server.ts to send. */
export interface RouteAnswer {
  status: number;
  body: AddedLauncherResponse | { ok: true; removed: number };
}

/** Who is asking, and where the audit lines go. */
export interface AddContext {
  sources: LauncherSources;
  /** The pairing label of the caller's device. `null` cannot add. */
  device: string | null;
  /** `crew` when the lead forwarded the request. */
  via: "local" | "crew";
  audit: AuditLog;
  session?: string;
  now?: () => number;
}

function refusal(status: number, body: ReturnType<typeof apiError>): RouteAnswer {
  return { status, body: { ok: false, ...body } };
}

function badText(field: "command" | "label", problem: TextProblem): RouteAnswer {
  return refusal(400, apiError("launcher.bad_text", { field, problem }));
}

function asRecord(value: JsonValue | undefined): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}

/**
 * `POST /api/launchers/added`. The body:
 *
 *   `requestId`   a UUID the phone mints per add; the row's id. A known one answers the row.
 *   `recipe`      `{ harness, options: [ids] }`: the bridge builds the line from its own table; or
 *   `text`        a line typed by hand, only when `[phone] free_text` is on, with `kind`
 *                 (`agent` needs `harness`) and `noPrompts` (the person's own tick);
 *   `label`       optional; the recipe's words or the line's first word otherwise.
 */
export async function addLauncher(body: JsonValue, ctx: AddContext): Promise<RouteAnswer> {
  const fields = asRecord(body);
  if (fields === null) return refusal(400, apiError("launcher.bad_recipe", { reason: "bad body" }));
  const requestId = fields.requestId;
  if (!isRequestId(requestId)) return refusal(400, apiError("launcher.bad_recipe", { reason: "bad requestId" }));

  // A retry of an add that landed answers that row and runs nothing again, whatever else it says.
  const earlier = await ctx.sources.added.get(requestId);
  if (earlier !== undefined) return { status: 200, body: { ok: true, row: addedWire(earlier), replayed: true } };

  if (ctx.device === null || ctx.device === "") return refusal(403, apiError("launcher.no_device"));
  const switches = await ctx.sources.switches();
  if (!switches.adds) return refusal(403, apiError("launcher.adds_off"));

  const recipe = asRecord(fields.recipe);
  const typed = fields.text;
  if ((recipe === null) === (typed === undefined)) {
    return refusal(400, apiError("launcher.bad_recipe", { reason: "name exactly one of recipe and text" }));
  }

  // `label` here is the default: the recipe's words, or `null` for the line's first word.
  let row: Omit<AddedLauncher, "label"> & { label: string | null };
  if (recipe !== null) {
    const harness = typeof recipe.harness === "string" ? recipe.harness : "";
    const options = Array.isArray(recipe.options) && recipe.options.every((o) => typeof o === "string") ? recipe.options : null;
    if (options === null) return refusal(400, apiError("launcher.bad_recipe", { reason: "options must be a list of ids" }));
    // SAFETY: every element was just checked to be a string.
    const built = buildRecipe(harness, options as string[]);
    if (!built.ok) return refusal(400, apiError("launcher.bad_recipe", { reason: built.reason }));
    row = {
      id: requestId,
      kind: "agent",
      harness,
      source: "recipe",
      options: built.options,
      command: built.command,
      label: built.label,
      noPrompts: built.noPrompts,
      device: ctx.device,
      via: ctx.via,
      at: (ctx.now ?? Date.now)(),
    };
  } else {
    if (!switches.freeText) return refusal(403, apiError("launcher.free_text_off"));
    if (typeof typed !== "string") return badText("command", "empty");
    const line = cleanLauncherText(typed, MAX_COMMAND_CHARS);
    if (!line.ok) return badText("command", line.problem);
    const kind = fields.kind;
    if (kind !== "agent" && kind !== "command") return refusal(400, apiError("launcher.bad_recipe", { reason: "kind must be agent or command" }));
    let harness: string | undefined;
    if (kind === "agent") {
      if (typeof fields.harness !== "string" || harnessLaunch(fields.harness) === undefined) {
        return refusal(400, apiError("launcher.bad_recipe", { reason: "unknown_harness" }));
      }
      harness = fields.harness;
    }
    row = {
      id: requestId,
      kind,
      source: "text",
      command: line.text,
      label: null,
      // The person's tick, OR a flag the scan knows: an alias hides its flags, a visible flag is never "prompts".
      noPrompts: fields.noPrompts === true || scanNoPrompts(line.text),
      device: ctx.device,
      via: ctx.via,
      at: (ctx.now ?? Date.now)(),
    };
    if (harness !== undefined) row.harness = harness;
  }

  // The label: the person's, checked by the same rule, else the recipe's words, else the first word.
  let label: string;
  if (fields.label !== undefined && fields.label !== null && fields.label !== "") {
    if (typeof fields.label !== "string") return badText("label", "empty");
    const name = cleanLauncherText(fields.label, MAX_LABEL_CHARS);
    if (!name.ok) return badText("label", name.problem);
    label = name.text;
  } else {
    const first = [...(row.label ?? row.command.split(/\s+/)[0] ?? row.command)].slice(0, MAX_LABEL_CHARS).join("");
    label = first;
  }

  const operator = await ctx.sources.operator();
  if (operator.some((r) => r.command === row.command)) return refusal(409, apiError("launcher.duplicate"));

  const full: AddedLauncher = { ...row, label };
  const outcome = await ctx.sources.added.add(full);
  if (!outcome.ok) {
    if (outcome.reason === "duplicate") return refusal(409, apiError("launcher.duplicate"));
    if (outcome.reason === "full") return refusal(409, apiError("launcher.added_full", { max: MAX_ADDED }));
    return refusal(503, apiError("launcher.store_unreadable"));
  }
  if (outcome.replayed) return { status: 200, body: { ok: true, row: addedWire(outcome.row), replayed: true } };
  ctx.audit.record({
    action: "launcher.add",
    session: ctx.session,
    device: ctx.device,
    detail: {
      requestId: full.id,
      kind: full.kind,
      harness: full.harness,
      source: full.source,
      command: full.command,
      label: full.label,
      noPrompts: full.noPrompts,
    },
  });
  return { status: 200, body: { ok: true, row: addedWire(full) } };
}

/** `POST /api/launchers/added/remove` `{ id }`. Any paired write device on this machine may remove a phone row. */
export async function removeLauncher(body: JsonValue, ctx: AddContext): Promise<RouteAnswer> {
  const id = asRecord(body)?.id;
  if (!isRequestId(id)) return refusal(400, apiError("launcher.unknown_row"));
  const gone = await ctx.sources.added.remove(id);
  if (gone === "unwritable") return refusal(503, apiError("launcher.store_unreadable"));
  if (gone === null) return refusal(404, apiError("launcher.unknown_row"));
  ctx.audit.record({
    action: "launcher.remove",
    session: ctx.session,
    device: ctx.device,
    detail: { requestId: gone.id, command: gone.command, label: gone.label, addedBy: gone.device, reason: "removed" },
  });
  return { status: 200, body: { ok: true, removed: 1 } };
}

/** `POST /api/launchers/added/rename` `{ id, label }`. */
export async function renameLauncher(body: JsonValue, ctx: AddContext): Promise<RouteAnswer> {
  const fields = asRecord(body);
  const id = fields?.id;
  if (!isRequestId(id)) return refusal(400, apiError("launcher.unknown_row"));
  if (typeof fields?.label !== "string") return badText("label", "empty");
  const name = cleanLauncherText(fields.label, MAX_LABEL_CHARS);
  if (!name.ok) return badText("label", name.problem);
  const renamed = await ctx.sources.added.rename(id, name.text);
  if (renamed === "unwritable") return refusal(503, apiError("launcher.store_unreadable"));
  if (renamed === null) return refusal(404, apiError("launcher.unknown_row"));
  ctx.audit.record({
    action: "launcher.rename",
    session: ctx.session,
    device: ctx.device,
    detail: { requestId: renamed.id, label: renamed.label },
  });
  return { status: 200, body: { ok: true, row: addedWire(renamed) } };
}

/**
 * Remove every row a device added on this machine, and log each. `via` narrows it to the rows that
 * came the same way: a revoke on THIS machine's registry names `local` rows, a forget the lead sent
 * names `crew` rows (a crew label and a local label are two different namespaces).
 */
export async function forgetDeviceRows(
  added: AddedLauncherSurface,
  device: string,
  via: "local" | "crew",
  audit: AuditLog,
  reason: string,
): Promise<AddedLauncher[]> {
  const gone = await added.removeWhere((r) => r.device === device && r.via === via);
  for (const row of gone) {
    audit.record({
      action: "launcher.remove",
      device: null,
      detail: { requestId: row.id, command: row.command, label: row.label, addedBy: row.device, reason },
    });
  }
  return gone;
}

/**
 * The read-time sweep: `local` rows whose device is no longer in this machine's pairing registry go.
 * It is the backstop for a revoke this process did not see (the bridge was down, or the file was
 * edited by hand); the revoke paths remove the rows themselves first. `labels` is `null` when the
 * registry cannot be read, and then nothing is removed: not knowing is not a revoke.
 */
export async function sweepRevokedRows(
  added: AddedLauncherSurface,
  labels: ReadonlySet<string> | null,
  audit: AuditLog,
): Promise<AddedLauncher[]> {
  if (labels === null) return [];
  const stale = (await added.list()).some((r) => r.via === "local" && !labels.has(r.device));
  if (!stale) return [];
  const gone = await added.removeWhere((r) => r.via === "local" && !labels.has(r.device));
  for (const row of gone) {
    audit.record({
      action: "launcher.remove",
      device: null,
      detail: { requestId: row.id, command: row.command, label: row.label, addedBy: row.device, reason: "device-revoked" },
    });
  }
  return gone;
}

/**
 * Which labels disappeared from a registry since the last look. Seeded on the first call, so a bridge
 * that starts sees nothing as revoked. The lead uses it to forward a forget to its crew members, which
 * cannot see its registry (ADR 0094).
 */
export function createRevokeWatch(): (labels: ReadonlySet<string> | null) => string[] {
  let last: ReadonlySet<string> | null = null;
  return (labels) => {
    if (labels === null) return [];
    const before = last;
    last = new Set(labels);
    if (before === null) return [];
    return [...before].filter((l) => !labels.has(l));
  };
}
