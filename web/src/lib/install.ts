import { useSyncExternalStore } from "react";

// The PWA install offer, held for the moment the operator asks for it.
//
// Chromium fires ONE `beforeinstallprompt` per page when the app is installable and not yet
// installed. Left alone, it becomes the browser's own mini-infobar at a moment nobody chose;
// captured, it becomes a button on the Settings page. This module is that capture: it prevents the
// default, keeps the event, and exposes "is an offer on the table" as a subscribable fact. The
// listener hangs off the module's import (main.tsx pulls it in), because the event fires early and
// a component-mounted listener would usually be too late to hear it.
//
// WHAT ABSENCE MEANS, because the button's absence is this module's main output: the browser never
// made the offer. Already installed (Chromium does not fire it for a running installed app, and
// `appinstalled` below clears a held one), not a secure context (the SW comment in CLAUDE.md — over
// plain HTTP the whole PWA machinery no-ops silently), or a browser that has no such event at all —
// iOS Safari installs through the share sheet and never fires it. All three resolve the same way:
// no card, no dead button, nothing to explain.
//
// The event is SINGLE-USE by contract (`prompt()` rejects the second time), so `promptInstall`
// takes it off the table before calling it — a dismissal is the operator's answer, not an invitation
// to re-ask, and the browser re-fires the event on a later visit anyway.

/** The two members Chromium's nonstandard event adds to `Event`. Never constructed here. */
interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** True for the browser's install-offer event. A structural check, not a cast: the event type is
 *  nonstandard, so the shape is the only thing there is to trust. */
function isInstallPrompt(e: Event): e is InstallPromptEvent {
  return "prompt" in e && "userChoice" in e;
}

let offer: InstallPromptEvent | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (typeof window !== "undefined") {
  window.addEventListener("beforeinstallprompt", (e) => {
    if (!isInstallPrompt(e)) return;
    e.preventDefault();
    offer = e;
    emit();
  });
  // Installed through ANY path while the page is open — the button, the browser's own menu — the
  // offer is spent either way.
  window.addEventListener("appinstalled", () => {
    offer = null;
    emit();
  });
}

/** True while the browser's install offer is on the table. */
export function useInstallOffer(): boolean {
  return useSyncExternalStore(subscribe, () => offer !== null, () => false);
}

/** Show the browser's install dialog and spend the offer. A no-op when none is held. */
export async function promptInstall(): Promise<void> {
  const held = offer;
  if (held === null) return;
  offer = null;
  emit();
  try {
    await held.prompt();
  } catch {
    // Spent, or the browser refused the moment (not a user gesture, dialog already up). The next
    // visit gets a fresh event; there is nothing useful to surface from here.
  }
}

/** Test-only: drop a held offer so cases start equal. */
export function __resetInstall(): void {
  offer = null;
  emit();
}
