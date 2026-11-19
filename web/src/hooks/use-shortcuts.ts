import { useEffect, useMemo } from "react";
import { useLocation } from "react-router";

import { useNav } from "@/hooks/use-nav";
import { useShortcutHandler } from "@/hooks/use-shortcut-handler";
import { noteKeyPress } from "@/lib/hardware-keyboard";
import { isCatchingUp, isLocked } from "@/lib/idle";
import { homePath, newPath, settingsPath } from "@/lib/nav";
import { useOperatorShortcuts, type OperatorShortcutsWire } from "@/lib/operator-config";
import type { Scope } from "@/lib/scope";
import { ACTIONS } from "@/lib/shortcuts/actions";
import { buildKeymap } from "@/lib/shortcuts/keymap";
import { hasShortcutTarget, paneKeySink, runShortcutAction, type PaneKeySink } from "@/lib/shortcuts/registry";
import { createResolver, type Resolver } from "@/lib/shortcuts/resolve";
import { publishShortcutKeymap, publishShortcutMode } from "@/lib/shortcuts/state";
import type { Keymap, KeyLike, Outcome, UserShortcuts } from "@/lib/shortcuts/types";
import { chordToWireKey } from "@/lib/shortcuts/wire-key";

// THE DESKTOP SHORTCUTS, WIRED (M108 spec 03). One capture-phase `keydown` on `window`, mounted once
// in the root layout, feeds the resolver of lib/shortcuts/ and acts on its answer. The keymap core
// decides which action a key is; this file only listens, consumes the keys that are ours, and calls
// the handler the app registered for the action (lib/shortcuts/registry.ts).
//
// A key that is not ours is never touched: `pass` calls neither `preventDefault` nor `stopPropagation`,
// so the composer keeps Enter and Ctrl/Cmd+Enter and a sheet keeps Escape. Every other outcome is
// consumed, because the key meant something to the keymap and must not also reach the page.
//
// IN TYPE MODE (hooks/use-direct-typing.ts) THE PAGE IS A TERMINAL'S KEYBOARD. Only the prefix is
// ours there: a direct binding is typing, so it passes. The prefix then opens the one-shot mode as
// usual, and the prefix twice sends the prefix chord itself to the pane.

const MAC_PLATFORM = /Mac/;

function isMacPlatform(): boolean {
  return MAC_PLATFORM.test(navigator.platform);
}

function toKeyLike(event: KeyboardEvent): KeyLike {
  return {
    key: event.key,
    code: event.code,
    ctrlKey: event.ctrlKey,
    shiftKey: event.shiftKey,
    altKey: event.altKey,
    metaKey: event.metaKey,
    isComposing: event.isComposing,
    keyCode: event.keyCode,
    altGraph: event.getModifierState("AltGraph"),
    repeat: event.repeat,
  };
}

/** The wire's read-only lists as the keymap's own type. No file means no user bindings. */
function userBindings(wire: OperatorShortcutsWire | null): UserShortcuts {
  if (wire === null) return {};
  return Object.fromEntries(Object.entries(wire).map(([name, bindings]) => [name, [...bindings]]));
}

const PASS: Outcome = { type: "pass" };

/**
 * In Type mode a key the keymap would RUN from the normal mode is typing, so it goes on to the pane.
 * The resolver already moved (a sticky mode opened, say), so it goes back to normal.
 */
function onlyPrefixWhileTyping(outcome: Outcome, resolver: Resolver): Outcome {
  if (outcome.type !== "run" && outcome.type !== "mode") return outcome;
  resolver.reset();
  return PASS;
}

function act(outcome: Outcome, sink: PaneKeySink | null): void {
  if (outcome.type === "send-prefix") {
    // The write reports its own failure on the status line, like every Keys-tray tap.
    if (sink !== null) void sink.send([chordToWireKey(outcome.chord)]);
    return;
  }
  if (outcome.type === "run") runShortcutAction(outcome.action, outcome.index);
}

function handleKeyDown(event: KeyboardEvent, resolver: Resolver): void {
  // The first press of a physical key is remembered for this device: it is what offers the shortcut
  // list in Settings (lib/hardware-keyboard.ts). A key that is not ours is read, never touched.
  noteKeyPress(event);
  // Under the idle cover the app is inert: its keyboard is too.
  if (isLocked() || isCatchingUp()) return;
  const sink = paneKeySink();
  const startedNormal = resolver.mode === "normal";
  const answered = resolver.press(toKeyLike(event));
  const outcome = startedNormal && sink?.isDirectTyping() === true ? onlyPrefixWhileTyping(answered, resolver) : answered;
  // A sticky mode with no key that has a target here would only swallow typing.
  if (outcome.type === "mode" && !hasShortcutTarget(outcome.id)) resolver.reset();
  publishShortcutMode(resolver.mode);
  if (outcome.type === "pass") return;
  event.preventDefault();
  event.stopPropagation();
  act(outcome, sink);
}

/**
 * The keyboard half: build the keymap from the defaults and the operator's `shortcuts.toml`, listen,
 * put the resolver back to normal when the window loses focus, and end a pending prefix on a route change. Needs no
 * router, so a test mounts it alone; `routeKey` is anything that changes when the route does.
 */
export function useShortcutKeyboard(routeKey: string): Keymap {
  const user = useOperatorShortcuts();
  const keymap = useMemo(() => buildKeymap({ defaults: ACTIONS, user: userBindings(user), mac: isMacPlatform() }), [user]);
  const resolver = useMemo(() => createResolver(keymap), [keymap]);

  // The help list reads the keymap and its diagnostics from the store; the console gets each one once
  // per change of the file.
  useEffect(() => {
    publishShortcutKeymap(keymap);
    for (const diagnostic of keymap.diagnostics) console.warn(`collie shortcuts: ${diagnostic.message}`);
    return () => publishShortcutKeymap(null);
  }, [keymap]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event, resolver);
    const onBlur = () => {
      resolver.reset();
      publishShortcutMode(resolver.mode);
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onBlur);
      resolver.reset();
      publishShortcutMode(resolver.mode);
    };
  }, [resolver]);

  // A route change ends a pending prefix only. A sticky mode outlives it (its own keys move the route),
  // unless the new screen has no key of the mode with a target, when it would only swallow typing.
  useEffect(() => {
    resolver.cancelPrefix();
    const sticky = resolver.sticky;
    if (sticky !== null && !hasShortcutTarget(sticky)) resolver.reset();
    publishShortcutMode(resolver.mode);
  }, [routeKey, resolver]);

  return keymap;
}

/** The actions that need nothing but the router: Settings, the dashboard, New. */
function useRootHandlers(scope: Scope): void {
  const nav = useNav();
  const { pathname } = useLocation();
  useShortcutHandler("settings", pathname.startsWith("/settings") ? undefined : () => nav.down(settingsPath(scope)));
  // Up, not down, and `upTo` the named parent: the dashboard is every route's ancestor (ADR 0067).
  useShortcutHandler("home", pathname === "/" ? undefined : () => nav.upTo(homePath(scope)));
  useShortcutHandler(
    "new_workspace",
    pathname === "/new" ? undefined : () => nav.down(newPath({ machine: scope.host, session: scope.session })),
  );
}

/**
 * Mounted once, in the root layout. `scope` is the machine and session the screen shows, so Settings
 * and New open on the one in view, as their buttons do.
 */
export function useShortcuts(scope: Scope): void {
  const { pathname, search } = useLocation();
  useShortcutKeyboard(`${pathname}${search}`);
  useRootHandlers(scope);
}
