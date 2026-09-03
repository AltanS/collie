// Where a notification tap should land, split out of sw.ts so it's unit-testable without
// service-worker globals (sw.ts itself can't run under Vitest-on-Node — it touches `self`, workbox
// and `__WB_MANIFEST`). Same split as lib/push-decision: the SW keeps the glue (read the clients,
// call openWindow), the choice lives here as plain data in, plain data out.
//
// The rule this file encodes, and why each half of it exists:
//
//   1. A *visible* (or focused) client is a real, live window. Raising it is both correct and free,
//      so it wins. Same URL → just focus. Different URL → navigate, then focus.
//   2. If nothing is visible, `openWindow` runs FIRST, before any awaited navigate. On Android the
//      installed PWA's window is usually discarded while the phone is asleep, so `matchAll` hands
//      back stale clients whose `navigate()` takes real time and then resolves null. Awaiting even
//      one of those burns the transient user activation the tap granted us, and `openWindow` then
//      rejects with NotAllowedError — the tap does nothing at all. So: at most one awaited
//      operation (the `matchAll` in sw.ts) sits between the click event and `openWindow`.
//   3. Only when `openWindow` comes back empty do we fall back to navigating the leftover clients.
//      That keeps the guarantee from #147 ("a notification tap opens the page even when the tab was
//      discarded", commit 18cd9cb): a discarded tab must never swallow the tap. #147 fixed it by
//      treating a null `navigate()` as "this client is no good" and falling through to
//      `openWindow`; we keep that, and additionally stop paying for the discovery with the
//      activation budget by trying `openWindow` before the corpse instead of after it.
//      Spec: https://w3c.github.io/ServiceWorker/#client-navigate
//
// Every rejection is caught. A tap that raises nothing is the bug; a tap that raises the wrong
// window is merely untidy, so each step degrades into the next instead of throwing.

/**
 * A window that ended up on screen. The narrowest thing this module needs back from `navigate`,
 * `focus` and `openWindow` — a real `WindowClient` satisfies it structurally, and `null` means the
 * browser had nothing to give us (a discarded tab, or a refused open).
 */
export interface OpenedWindow {
  readonly url: string;
}

/**
 * The slice of `WindowClient` this module needs. A real `WindowClient` satisfies it structurally,
 * so sw.ts hands `clients.matchAll()` results straight in, and tests hand in plain objects.
 */
export interface OpenTargetClient {
  readonly url: string;
  readonly visibilityState?: DocumentVisibilityState;
  readonly focused?: boolean;
  navigate(url: string): Promise<OpenedWindow | null>;
  focus(): Promise<OpenedWindow>;
}

/** What to do with the clients we were given, decided before a single async call is made. */
export type OpenPlan =
  /** `clients[index]` is live and already on the target URL — raise it, nothing else. */
  | { kind: "focus"; index: number }
  /** `clients[index]` is live but elsewhere — navigate it, then raise it. */
  | { kind: "navigate-focus"; index: number }
  /**
   * Nothing is visible. Open a window first; `fallbacks` are the client indices worth navigating
   * (in order) only if `openWindow` comes back empty.
   */
  | { kind: "open-window"; fallbacks: number[] };

/** How the attempt ended. Returned so the caller can decide whether to close the notification. */
export type OpenOutcome = "focused" | "navigated" | "opened" | "failed";

const isVisible = (client: OpenTargetClient): boolean =>
  client.visibilityState === "visible" || client.focused === true;

/**
 * Pure client selection: given the windows the SW can see and the URL a tap should land on, decide
 * the shape of the attempt. No side effects, no awaits — see the rule at the top of this file.
 */
export function planNotificationOpen(clients: readonly OpenTargetClient[], url: string): OpenPlan {
  const sameUrlVisible = clients.findIndex((c) => isVisible(c) && c.url === url);
  if (sameUrlVisible !== -1) return { kind: "focus", index: sameUrlVisible };

  const otherUrlVisible = clients.findIndex(isVisible);
  if (otherUrlVisible !== -1) return { kind: "navigate-focus", index: otherUrlVisible };

  // Nothing visible: every one of these may be a discarded tab, so none of them may be awaited
  // before `openWindow`. They stay on the list as fallbacks only.
  return { kind: "open-window", fallbacks: clients.map((_, i) => i) };
}

export interface OpenNotificationTargetInput {
  /** Origin-absolute URL the tap should land on. */
  url: string;
  /** Windows the service worker can see, from `clients.matchAll({ type: "window", ... })`. */
  clients: readonly OpenTargetClient[];
  /** Injected `clients.openWindow`. Resolves null (or throws) when the browser refuses. */
  openWindow: (url: string) => Promise<OpenedWindow | null>;
}

/** `openWindow` is retried once on a throw: NotAllowedError is racy, and a second try is cheap. */
async function tryOpenWindow(input: OpenNotificationTargetInput): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const opened = await input.openWindow(input.url).catch(() => null);
    if (opened) return true;
  }
  return false;
}

/** Navigate the listed clients in order, first one that survives wins. This is the #147 path. */
async function tryNavigate(
  input: OpenNotificationTargetInput,
  indices: readonly number[],
): Promise<boolean> {
  for (const index of indices) {
    const client = input.clients[index];
    if (!client) continue;
    if (client.url !== input.url) {
      // A discarded tab resolves null here (#147). Treat it as no client at all and move on.
      const navigated = await client.navigate(input.url).catch(() => null);
      if (!navigated) continue;
    }
    const focused = await client.focus().then(
      () => true,
      () => false,
    );
    if (focused) return true;
  }
  return false;
}

/**
 * Run the plan. Never rejects: a failure at any step falls through to the next, and the worst case
 * is a `"failed"` outcome the caller can act on (sw.ts leaves the notification up so the user gets
 * a second tap).
 */
export async function openNotificationTarget(
  input: OpenNotificationTargetInput,
): Promise<OpenOutcome> {
  const plan = planNotificationOpen(input.clients, input.url);

  if (plan.kind === "focus") {
    const client = input.clients[plan.index];
    const focused = await client.focus().then(
      () => true,
      () => false,
    );
    if (focused) return "focused";
    return (await tryOpenWindow(input)) ? "opened" : "failed";
  }

  if (plan.kind === "navigate-focus") {
    // This client is visible, so it is alive: awaiting its navigate cannot cost us a corpse's worth
    // of activation, and we still hold the tap's activation if we need `openWindow` after it.
    if (await tryNavigate(input, [plan.index])) return "navigated";
    return (await tryOpenWindow(input)) ? "opened" : "failed";
  }

  // Nothing visible: window first, corpses second.
  if (await tryOpenWindow(input)) return "opened";
  if (await tryNavigate(input, plan.fallbacks)) return "navigated";
  return "failed";
}
