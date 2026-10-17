// Walky talky addresses (M62 README, "Addressing"). One opaque string per target:
//   `<memberId>/<paneId>`  one pane on one machine; on a solo install the member id is `local`
//   `<memberId>/all`       every agent pane on one machine
//   `all`                  every agent pane in the crew
// Every address is checked here before it is used, and none ever becomes a path: the log names its
// files by a hash (log.ts). A shell pane is never a target.

import { MEMBER_ID_RE } from "../crew/identity.ts";
import { headerField } from "./types.ts";

/** The member id of a solo install, and the name this bridge always answers to. */
export const LOCAL_MEMBER = "local";

/**
 * A pane id as an address may carry it: what the multiplexers mint (`w6:p3`, `%7`, `terminal_3`,
 * a number), at most 128 characters, never a `/` (the address separator) and never only dots.
 */
export const PANE_ID = /^[A-Za-z0-9_.:%@+=-]{1,128}$/u;

export function isPaneId(value: string): boolean {
  return PANE_ID.test(value) && !/^\.+$/u.test(value);
}

export type WalkyAddress =
  | { readonly kind: "all" }
  | { readonly kind: "member-all"; readonly memberId: string }
  | { readonly kind: "pane"; readonly memberId: string; readonly paneId: string };

function isMember(value: string): boolean {
  return value === LOCAL_MEMBER || MEMBER_ID_RE.test(value);
}

/** Read one address, or null when it is not one. */
export function parseAddress(raw: string): WalkyAddress | null {
  const value = raw.trim();
  if (value === "all") return { kind: "all" };
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const memberId = value.slice(0, slash);
  const rest = value.slice(slash + 1);
  if (!isMember(memberId)) return null;
  if (rest === "all") return { kind: "member-all", memberId };
  return isPaneId(rest) ? { kind: "pane", memberId, paneId: rest } : null;
}

/** The address of one pane on the machine with this member id (null: solo). */
export function paneAddress(memberId: string | null, paneId: string): string {
  return `${memberId ?? LOCAL_MEMBER}/${paneId}`;
}

/** Whether an address's member id names this bridge: its own member id, or `local`. */
export function isSelf(memberId: string, self: string | null): boolean {
  return memberId === LOCAL_MEMBER || (self !== null && memberId === self);
}

/** What a label is made from: the pane as the snapshot names it, and the branch of its folder. */
export interface LabelFacts {
  readonly paneId: string;
  readonly cwd: string;
  readonly branch: string | null;
  readonly paneLabel?: string;
  readonly terminalTitle?: string;
}

/**
 * A pane's label for a message and for `who`: `<repo>#<branch>` when the folder is a checkout on a
 * branch, else the label the operator gave the pane, else the folder's name, else the pane id. A
 * terminal title is used only when `titles` is true: with COLLIE_REDACT on, a program-set title is
 * masked on every other surface, so it never rides a message either.
 */
export function labelOf(facts: LabelFacts, titles: boolean): string {
  const repo = facts.cwd.split(/[\\/]/u).findLast((part) => part.length > 0) ?? "";
  if (repo !== "" && facts.branch !== null) return headerField(`${repo}#${facts.branch}`);
  if (facts.paneLabel !== undefined && facts.paneLabel.trim() !== "") return headerField(facts.paneLabel);
  if (titles && facts.terminalTitle !== undefined && facts.terminalTitle.trim() !== "") return headerField(facts.terminalTitle);
  return headerField(repo !== "" ? repo : facts.paneId);
}
