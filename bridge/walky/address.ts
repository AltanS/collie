// Walky talky addresses (M62 README, "Addressing"). One opaque string per target:
//   `<memberId>/<paneId>#<token>`  one pane instance: the session that holds that pane id now
//                         (instances.ts), so a pane that closed and gave its id away is not reached
//   `<memberId>/<paneId>`  whatever pane holds that id now; on a solo install the member id is `local`
//   `<memberId>/all`       every agent pane on one machine
//   `all`                  every agent pane in the crew
// Every address is checked here before it is used, and none ever becomes a path: the log names its
// files by a hash (log.ts). A shell pane is never a target.

import { MEMBER_ID_RE } from "../crew/identity.ts";
import { headerField, WALKY_LABEL_MAX } from "./types.ts";

/** The member id of a solo install, and the name this bridge always answers to. */
export const LOCAL_MEMBER = "local";

/**
 * A pane id as an address may carry it: what the multiplexers mint (`w6:p3`, `%7`, `terminal_3`,
 * a number), at most 128 characters, never a `/` (the address separator) and never only dots.
 */
export const PANE_ID = /^[A-Za-z0-9_.:%@+=-]{1,128}$/u;

/** A pane instance token as an address carries it after `#` (instances.ts mints them). */
export const INSTANCE_TOKEN = /^[a-z0-9]{4}$/u;

export function isPaneId(value: string): boolean {
  return PANE_ID.test(value) && !/^\.+$/u.test(value);
}

export type WalkyAddress =
  | { readonly kind: "all" }
  | { readonly kind: "member-all"; readonly memberId: string }
  | {
      readonly kind: "pane";
      readonly memberId: string;
      readonly paneId: string;
      /** The pane instance the address names, or null: whatever pane holds the id now. */
      readonly instance: string | null;
    };

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
  // `#` is not a pane id character, so the first one ends the id and starts the token.
  const hash = rest.indexOf("#");
  const paneId = hash < 0 ? rest : rest.slice(0, hash);
  const instance = hash < 0 ? null : rest.slice(hash + 1);
  // `all` names a whole machine, never a pane instance.
  if (!isPaneId(paneId) || paneId === "all" || (instance !== null && !INSTANCE_TOKEN.test(instance))) return null;
  return { kind: "pane", memberId, paneId, instance };
}

/** The address of one pane on the machine with this member id (null: solo), with its instance token when given. */
export function paneAddress(memberId: string | null, paneId: string, instance?: string | null): string {
  const bare = `${memberId ?? LOCAL_MEMBER}/${paneId}`;
  return instance === undefined || instance === null ? bare : `${bare}#${instance}`;
}

/**
 * An address without its instance token: what a receipt's `target` holds. A receipt names the pane
 * id only, so a lead's leg and a member's own receipt for it keep matching. Anything else unchanged.
 */
export function bareAddress(raw: string): string {
  const address = parseAddress(raw);
  return address?.kind === "pane" && address.instance !== null ? `${address.memberId}/${address.paneId}` : raw;
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
  if (repo !== "" && facts.branch !== null) return headerField(`${repo}#${facts.branch}`, WALKY_LABEL_MAX);
  if (facts.paneLabel !== undefined && facts.paneLabel.trim() !== "") return headerField(facts.paneLabel, WALKY_LABEL_MAX);
  if (titles && facts.terminalTitle !== undefined && facts.terminalTitle.trim() !== "") return headerField(facts.terminalTitle, WALKY_LABEL_MAX);
  return headerField(repo !== "" ? repo : facts.paneId, WALKY_LABEL_MAX);
}
