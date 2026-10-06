// The create verbs of the dashboard and the space view, as a module (web/src/hooks/use-spaces.ts,
// `useSpaceActions`): a new tab in a workspace (the heading's "+", the tab strip's "+"), a new space,
// and a launcher. Each one is refused up front on a read-only or unpaired device, holds a per-target
// in-flight mark so a second tap is swallowed, reports through the status line, starts the topology
// burst on the polling beat, and opens the fresh shell pane at the scope it was created on.
//
// The in-flight marks are one store (`creating`), so a "+" re-renders through `useStore` and never
// through a parent: rule 4.

import { createTab, createWorkspace, launch as launchCommand } from "@web/lib/api";
import { describeApiError, describeThrownError } from "@web/lib/api-error-message";
import { t } from "@web/lib/i18n";
import { panePath } from "@web/lib/nav";
import { scopeKey, type Scope } from "@web/lib/scope";
import type { CreateResponse } from "@web/lib/types";

import { navigate } from "../lib/navigate";
import { address } from "../lib/data";
import { kick, noteTopology } from "../lib/polling";
import { setStatus } from "../lib/status";
import { createStore } from "../lib/store";
import { href } from "../routes";
import { bridgeWrite, writeRefusal } from "./writes";

/** web/'s `tabCreateKey`: machine, session and workspace id, so two machines' `w1` never share a mark. */
export function tabCreateKey(workspaceId: string, scope: Scope | undefined): string {
  return `${scopeKey(scope)}\u0000${workspaceId}`;
}

/** Key of the one "new space" create (any scope): web/ allows one at a time. */
export const SPACE_CREATE_KEY = "\u0001space";

/** Key of one launcher in flight. */
export function launchKey(command: string): string {
  return `\u0002${command}`;
}

/** Every create in flight, by key. A new Set per change, so `useStore` sees it. */
export const creating = createStore<ReadonlySet<string>>(new Set());

function hold(key: string): boolean {
  if (creating.get().has(key)) return false;
  creating.update((s) => new Set([...s, key]));
  return true;
}

function release(key: string): void {
  creating.update((s) => {
    const next = new Set(s);
    next.delete(key);
    return next;
  });
}

function opened(res: CreateResponse, what: "tab" | "space", at: Scope | undefined): void {
  if (!res.ok) {
    setStatus(describeApiError(res), "error");
    return;
  }
  const noun = what === "tab" ? t("space.noun.tab") : t("space.noun.space");
  setStatus(t("space.create.ready", { what: noun }), "success");
  noteTopology();
  kick();
  void navigate(href(panePath(res.pane.paneId, at ?? address.get().scope)));
}

async function run(key: string, what: "tab" | "space", at: Scope | undefined, op: () => Promise<CreateResponse>): Promise<void> {
  const refused = writeRefusal();
  if (refused !== undefined) {
    setStatus(refused, "error");
    return;
  }
  if (!hold(key)) return;
  try {
    opened(await bridgeWrite(op), what, at);
  } catch (error) {
    setStatus(describeThrownError(error), "error");
  } finally {
    release(key);
  }
}

/** A new tab in `workspaceId`, on the machine and session `at` names (the ambient scope when absent). */
export function newTab(workspaceId: string, at?: Scope): Promise<void> {
  const scope = at ?? address.get().scope;
  return run(tabCreateKey(workspaceId, scope), "tab", scope, () => createTab(workspaceId, {}, scope));
}

/** A new space with a fresh shell; `opts.cwd` omitted is the host's home directory. */
export function newSpace(opts: { label?: string; cwd?: string } = {}, at?: Scope): Promise<void> {
  const scope = at ?? address.get().scope;
  return run(SPACE_CREATE_KEY, "space", scope, () => createWorkspace(opts, scope));
}

/** Run a launcher (an allowlist key the bridge resolves); `beside` opens it as a tab beside that pane. */
export function launch(command: string, beside?: string, at?: Scope): Promise<void> {
  const scope = at ?? address.get().scope;
  return run(launchKey(command), beside === undefined ? "space" : "tab", scope, () => launchCommand(command, beside, scope));
}
