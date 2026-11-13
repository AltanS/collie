// The session names a `who` row carries (M62, added 2026-11-13): the name a person gave the session and
// where, and the title the agent gave it. An agent addresses "the session in workspace X" by matching
// the SPACE, the FOLDER (`label`), the NAME or the TITLE of a row, so every one of them must be on the
// row. Display data: the receiving bridge decides every send itself, so nothing here is signed.

import { personName } from "../pane-name.ts";
import type { AgentView } from "../types.ts";
import { WALKY_NAME_MAX } from "./types.ts";

/** Who set a session's name, as a row says it. */
export type WalkyNameBy = "collie" | "harness" | "tab";

/** The names fields a row may carry. */
export interface WalkyNames {
  name?: string;
  nameBy?: WalkyNameBy;
  title?: string;
}

/**
 * The names of one pane as a `who` row carries them. The agent's title rides only when `titles` is
 * true: with COLLIE_REDACT on it is the agent's text, and a listing leaves it out as it leaves out the
 * terminal title (address.ts `labelOf`).
 */
export function namesOfPane(pane: Partial<Pick<AgentView, "paneLabel" | "sessionName" | "soleTabName" | "agentTitle">>, titles: boolean): WalkyNames {
  const person = personName(pane);
  const title = titles ? bounded(pane.agentTitle) : undefined;
  const name = person === null ? undefined : bounded(person.name);
  const out: WalkyNames = {};
  if (name !== undefined && person !== null) {
    out.name = name;
    out.nameBy = person.by;
  }
  if (title !== undefined) out.title = title;
  return out;
}

/** A row with the names fields of `from` added, each only when it is there. */
export function withNames<T extends object>(row: T, from: WalkyNames): T & WalkyNames {
  const out: T & WalkyNames = { ...row };
  if (from.name !== undefined) out.name = from.name;
  if (from.nameBy !== undefined) out.nameBy = from.nameBy;
  if (from.title !== undefined) out.title = from.title;
  return out;
}

/** A name or title within the row's cap, trimmed; undefined when it is empty or absent. */
export function bounded(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (trimmed === "") return undefined;
  const points = Array.from(trimmed);
  return points.length <= WALKY_NAME_MAX ? trimmed : points.slice(0, WALKY_NAME_MAX).join("");
}
