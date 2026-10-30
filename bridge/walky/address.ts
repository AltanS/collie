// Walky talky addresses (M62 README, "Addressing"). One opaque string per target:
//   `<memberId>/<paneId>#<token>`  one pane instance: the session that holds that pane id now
//                         (instances.ts), so a pane that closed and gave its id away is not reached
//   `<memberId>/<paneId>`  whatever pane holds that id now; on a solo install the member id is `local`
//   `<memberId>/all`       every agent pane on one machine
//   `all`                  every agent pane in the crew
//   `<repo>`               every agent pane in a folder of that name, on every machine of the crew
//   `<repo>#<branch>`      the same, on one branch
//   `here`                 the sender's own folder on every machine, without the sender's own pane
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
  /** A folder name (the `<repo>` of a pane's label), on one branch or on any (`branch: null`). */
  | { readonly kind: "workspace"; readonly repo: string; readonly branch: string | null }
  /** The sender's own folder, on every machine, without the sender's own pane. */
  | { readonly kind: "here" }
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

/**
 * A workspace part (a repo or a branch) as an address may carry it: non-empty, and left whole by the
 * label rules (`headerField`): printable ASCII, no `[ ] ( )`, no run of blanks, at most `WALKY_LABEL_MAX`.
 */
function isWorkspacePart(part: string): boolean {
  return part !== "" && part !== "-" && headerField(part, WALKY_LABEL_MAX) === part;
}

/** A word with no `/` before its first `#`: `<repo>`, `<repo>#<branch>`, or `here`. The member ids are not known here, so a clash with one is for the caller. */
function parseWorkspace(value: string): WalkyAddress | null {
  if (value === "here") return { kind: "here" };
  const hash = value.indexOf("#");
  const repo = hash < 0 ? value : value.slice(0, hash);
  const branch = hash < 0 ? null : value.slice(hash + 1);
  // `all` and `here` are words of their own, never a folder, even with a branch behind them.
  if (repo === "all" || repo === "here") return null;
  if (!isWorkspacePart(repo) || (branch !== null && !isWorkspacePart(branch))) return null;
  return { kind: "workspace", repo, branch };
}

/** Read one address, or null when it is not one. */
export function parseAddress(raw: string): WalkyAddress | null {
  const value = raw.trim();
  if (value === "all") return { kind: "all" };
  const slash = value.indexOf("/");
  const firstHash = value.indexOf("#");
  // A pane address has its `/` before any `#` (`<member>/<pane>#<token>`). A `#` first is a
  // workspace with a branch, and the branch may hold a `/` (`repo#feat/x`).
  if (slash < 0 || (firstHash >= 0 && firstHash < slash)) return parseWorkspace(value);
  if (slash === 0) return null;
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

/** A workspace scope: a folder name, on one branch or on any (`branch: null`). */
export interface WalkyScope {
  readonly repo: string;
  readonly branch: string | null;
}

/** Whether an address is a scope (`<repo>`, `<repo>#<branch>`, `here`): the lead expands it into one delivery per pane. */
export function isScopeAddress(address: WalkyAddress | null): address is Extract<WalkyAddress, { kind: "workspace" | "here" }> {
  return address !== null && (address.kind === "workspace" || address.kind === "here");
}

/**
 * The scope a pane's label stands in: the part before its first `#` as the repo and the rest as the
 * branch (`labelOf` writes `<repo>#<branch>`), or the whole label with no branch. Null when the label
 * names no folder: it is the pane id itself, or empty (`-`).
 */
export function labelScope(label: string, paneId: string): WalkyScope | null {
  if (label === "" || label === "-" || label === paneId) return null;
  const hash = label.indexOf("#");
  if (hash < 0) return { repo: label, branch: null };
  const repo = label.slice(0, hash);
  return repo === "" ? null : { repo, branch: label.slice(hash + 1) };
}

/** Whether a pane's label sits in a scope: the same repo, and the same branch when the scope names one. */
export function inScope(label: string, paneId: string, scope: WalkyScope): boolean {
  const own = labelScope(label, paneId);
  if (own === null || own.repo !== scope.repo) return false;
  return scope.branch === null || own.branch === scope.branch;
}
