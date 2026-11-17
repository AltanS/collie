import type { AccountHarness, AccountIdentity, AccountRow } from "@/lib/accounts";

// CHANGE LOGIN (M101): one account's login, changed by the agent's own sign-in while the sessions of
// that account keep running. The bridge starts the sign-in exactly as "Sign in again" does (the same
// launch, the same gate, the same audit line); this module is the phone's memory of one such flow and
// the pure rules of its screens.
//
// THE FLOW, IN MEMORY ONLY. Which account, the sign-in session's pane, who was signed in before, and the
// page the person came from. Nothing of it is written to storage, sent to the bridge or logged; the
// email in `before` is the one the Accounts page already shows. A reload of the app forgets the flow,
// and the sign-in session then stays open like any session: the person closes it from its own page.
//
// SUCCESS IS WHAT THE AGENT SAYS AFTERWARDS. The phone ends the sign-in session and asks the bridge who
// is signed in now (the agent's own status command, M101 spec 04). A changed email is a changed login;
// the same email says "Still signed in as", which is true whether the person signed in with the same
// account again or left the sign-in: the agent changes nothing before a sign-in succeeds.

/** One flow that is waiting for its sign-in session. */
export interface ChangeLoginFlow {
  /** The account's id, `claude:default` for a Default row. */
  account: string;
  /** The sign-in session's pane, on this machine. */
  paneId: string;
  /** Who was signed in when the flow started. Absent: unknown. */
  before?: AccountIdentity;
  /** The page the person came from (a session, or the account's page). Null: the account's page. */
  from: string | null;
}

const flows = new Map<string, ChangeLoginFlow>();

/** Keep a flow once its sign-in session started. A second flow for the same account replaces the first. */
export function rememberFlow(flow: ChangeLoginFlow): void {
  flows.set(flow.account, flow);
}

/** The flow of an account, or undefined. */
export function flowOf(account: string): ChangeLoginFlow | undefined {
  return flows.get(account);
}

/** Forget an account's flow. */
export function forgetFlow(account: string): void {
  flows.delete(account);
}

/** Whether the account reads signed in, so its page offers Change login and not Sign in again. */
export function offersChangeLogin(row: AccountRow): boolean {
  return row.identity?.signedIn === true;
}

/** What the screens say about the sessions that already run: they follow, or only new ones do. */
export type Reach = { kind: "running"; count: number } | { kind: "newOnly" };

/** The reach of a harness's sign-in. `count` is 0 when no session of the account runs. */
export function reachOf(harness: AccountHarness | undefined, row: AccountRow): Reach {
  if (harness?.reachesRunningSessions !== true) return { kind: "newOnly" };
  return { kind: "running", count: row.running ?? 0 };
}

/** Whether the list holds another profile of the row's agent: Default plus an added one, or two added. */
export function hasOtherProfiles(rows: readonly AccountRow[], row: AccountRow): boolean {
  return rows.some((other) => other.harness === row.harness && other.id !== row.id);
}

/** The result screen: who is signed in after the flow, set against who was before. */
export type ChangeLoginResult =
  | { kind: "changed"; email: string; plan?: string }
  | { kind: "same"; email: string; plan?: string }
  | { kind: "signedOut" }
  | { kind: "unknown" };

/** The result from the identity before the flow and the one read after the sign-in session ended. */
export function resultOf(before: AccountIdentity | undefined, after: AccountIdentity | undefined): ChangeLoginResult {
  if (after === undefined) return { kind: "unknown" };
  if (!after.signedIn) return { kind: "signedOut" };
  if (after.email === undefined) return { kind: "unknown" };
  const plan = after.plan === undefined ? {} : { plan: after.plan };
  if (before?.signedIn === true && before.email !== undefined && before.email.toLowerCase() === after.email.toLowerCase()) {
    return { kind: "same", email: after.email, ...plan };
  }
  return { kind: "changed", email: after.email, ...plan };
}

/** Whether a read while the sign-in session runs already shows a new login, so the flow can end itself. */
export function loginChanged(before: AccountIdentity | undefined, now: AccountIdentity | undefined): boolean {
  return resultOf(before, now).kind === "changed" && before?.signedIn === true && before.email !== undefined;
}

/** Whether the page the person came from is a session. */
export function cameFromSession(from: string | null): boolean {
  return from !== null && /^\/pane\/[^/?#]+(?:[?#]|$)/u.test(from);
}
