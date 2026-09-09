import { useEffect, useSyncExternalStore } from "react";

import { fetchConfig } from "@/lib/api";
import { acceptOperatorFonts, applyOperatorFonts, type OperatorFontFace } from "@/lib/operator-fonts";
import { designPrefs, subscribeDesign } from "@/lib/design";
import type {
  MuxConfig,
  OperatorCommand,
  OperatorKeyRow,
  OperatorQuickReplyRow,
  SttCapability,
  UploadCapability,
} from "@/lib/types";

// The startup-resolved half of /api/config, read ONCE and held in module state: the operator's own
// rows (their `commands.toml` palette, their `keys.toml` tray presets and their
// `quick-replies.toml` dock groups) and the multiplexer's declared
// capabilities (M10/06). They all ride the same request because they are the same kind of thing —
// config the bridge resolves at startup and the client reads once.
//
// THE CAPABILITIES BELONG HERE RATHER THAN IN A SECOND STORE for the reason the header already
// gives: this is ONE /api/config call, never a second channel. A capability store with its own
// fetch would double the request and could disagree with this one about what the same response
// said. lib/mux-capability.ts holds the POLICY (what an absent answer means, which control asks
// what); this file holds only the bytes.
//
// Modelled on the lib/server-build.ts store idiom: plain module state + subscribe + a
// useSyncExternalStore hook, so the composer participates without prop-drilling through the route
// tree.
//
// THE CONTRACT: one SUCCESSFUL read is cached for the life of the page; a failed attempt is not
// cached, so a later mount tries again. Never polled, and deliberately not folded into the 1.5s
// snapshot: this is startup config on the bridge side (loadConfig() runs once, bridge/index.ts), so
// re-reading it every tick would spend bytes on a value that cannot change without a bridge
// restart. Which is also why changing it takes a bridge restart AND a page load, not just the
// restart — the same contract every other COLLIE_* var has, and what `.env.example` promises.
//
// A FAILED FETCH IS NOT AN ERROR STATE. With no rows, every pane falls back to its shipped catalog,
// which is exactly what a user without this var already sees. So a refusal (read-only
// device, auth lapse) or an offline start leaves an empty list and no status noise, and the single
// in-flight promise is cleared so a later MOUNT retries. Retry granularity is the reason the kick
// below lives in an effect and not in the render body: the composer re-renders on every 1.5s
// snapshot, so a render-phase kick would turn one refusal into a request per tick, forever.

let current: readonly OperatorCommand[] = [];
let currentKeys: readonly OperatorKeyRow[] = [];
let currentReplies: readonly OperatorQuickReplyRow[] = [];
// The operator's typefaces, already re-validated: nothing downstream of this store should ever see
// a row this client would refuse to render (lib/operator-fonts.ts owns the grammar).
let currentFonts: readonly OperatorFontFace[] = [];
// `null` until a read succeeds, AND on a bridge that publishes none — the two are deliberately the
// same value, because both mean "nothing said otherwise" and mux-capability.ts answers both the
// same way: capable.
let currentMux: MuxConfig | null = null;
// `null` until a read succeeds AND on every bridge whose operator configured no provider — the two
// are the same value on purpose, because both mean "there is no microphone here" (ADR 0029). Absent
// is the feature being off, so nothing has to distinguish them.
let currentStt: SttCapability | null = null;
// `null` until a read succeeds AND on every bridge older than the field. The two are the same value
// on purpose: both mean "nothing said otherwise", and lib/attachments.ts answers both with the
// contract that shipped before attachments existed — 10 MB, images only.
let currentUpload: UploadCapability | null = null;
let inflight: Promise<void> | null = null;
let loaded = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const fn of listeners) fn();
}

/** Read the list once per page load. Concurrent callers share the one in-flight request. */
export function loadOperatorCommands(): Promise<void> {
  if (loaded) return Promise.resolve();
  if (inflight) return inflight;
  inflight = (async () => {
    try {
      const cfg = await fetchConfig();
      current = cfg.operatorCommands ?? [];
      currentKeys = cfg.operatorKeys ?? [];
      currentReplies = cfg.operatorQuickReplies ?? [];
      currentFonts = acceptOperatorFonts(cfg.operatorFonts ?? []);
      // The server's rows are now the authority, superseding the single face design.ts mirrored into
      // storage for this cold load. Applied here rather than by a component so a face the operator
      // DELETED stops rendering even on a page that never mounts the Typeface card — this call
      // emits less CSS than the mirror did, which is how the removal takes effect.
      applyOperatorFonts(currentFonts, designPrefs().font);
      currentMux = cfg.mux ?? null;
      currentStt = cfg.stt ?? null;
      currentUpload = cfg.upload ?? null;
      loaded = true;
      emit();
    } catch {
      // Additive feature — see the header. Leave the list empty and allow a later retry.
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}

export function getOperatorCommands(): readonly OperatorCommand[] {
  return current;
}

export function getOperatorKeys(): readonly OperatorKeyRow[] {
  return currentKeys;
}

export function getOperatorQuickReplies(): readonly OperatorQuickReplyRow[] {
  return currentReplies;
}

/**
 * The operator's typefaces, validated. Empty until a read succeeds, on a bridge with no `theme.toml`,
 * and on one older than the field — all three mean "this collie offers no extra faces", which is the
 * same thing the picker should show for each.
 */
export function getOperatorFonts(): readonly OperatorFontFace[] {
  return currentFonts;
}

/**
 * The multiplexer block, or `null` when nothing has said otherwise (no read yet, a failed read, or a
 * bridge older than the field). Every consumer goes through lib/mux-capability.ts, which is where
 * `null` is turned into an answer.
 */
export function getMuxConfig(): MuxConfig | null {
  return currentMux;
}

// ── ONE MEMBER's OWN BLOCK (M22/03) ─────────────────────────────────────────────────────────────
//
// The store above is the LEAD's answer, read once and held for the page. A crew member runs its own
// multiplexer, so a control on that member's pane has to ask that member's declaration, and the lead
// answers it on `/api/config?host=<member>` from what the member's last `hello` taught it.
//
// A SECOND MAP RATHER THAN A SECOND STORE, and it stays out of the one-shot read's way:
//
//  • **Cached per host id, for the life of the page**, exactly as the lead's read is cached. The
//    block cannot change without that member's bridge restarting, which the phone cannot miss.
//  • **Issued ONLY when a scope names a non-lead host.** A solo install has no `?h=` to emit, so it
//    never reaches this map and never makes a second request — the zero-tax rule, client side.
//  • **A miss is `null`, and `null` means "use the lead's".** So the read in flight, the failed read
//    and the member that publishes no block all render the answer the phone gives today.
//  • **A failed read is not cached**, on the same terms the lead's read is not, so a later mount
//    tries again.

const hostMux = new Map<string, MuxConfig | null>();
const hostMuxInflight = new Map<string, Promise<void>>();

/**
 * Read one member's own mux block, once per host id per page load. Concurrent callers share the one
 * in-flight request.
 */
export function loadHostMuxConfig(host: string): Promise<void> {
  if (hostMux.has(host)) return Promise.resolve();
  const running = hostMuxInflight.get(host);
  if (running) return running;
  const started = (async () => {
    try {
      // The HOST alone. No session rides along: `/api/config` is not session-scoped, and sending a
      // session name would put a parameter on the wire that the route does not read.
      const cfg = await fetchConfig({ host });
      hostMux.set(host, cfg.mux ?? null);
      emit();
    } catch {
      // Additive feature — see the header. Nothing is cached, so a later mount asks again.
    } finally {
      hostMuxInflight.delete(host);
    }
  })();
  hostMuxInflight.set(host, started);
  return started;
}

/**
 * One member's own mux block, or `null` when nothing has said otherwise: no read yet, a failed read,
 * or a member the lead has no declaration for. All three mean "use the lead's answer", which is what
 * lib/mux-capability.ts turns them into.
 */
export function getHostMuxConfig(host: string): MuxConfig | null {
  return hostMux.get(host) ?? null;
}

/**
 * The speech-to-text block, or `null` when nothing said otherwise (no read yet, a failed read, or a
 * bridge with no provider configured). Consumers go through lib/stt.ts, which owns the rule that
 * turns this plus the browser's own microphone support into "draw the button or don't".
 */
export function getSttCapability(): SttCapability | null {
  return currentStt;
}

/**
 * What this collie accepts as an attachment, or `null` when nothing has said otherwise (no read yet,
 * a failed read, or a bridge older than the field). Consumers go through lib/attachments.ts, which
 * is where `null` becomes an answer.
 */
export function getUploadCapability(): UploadCapability | null {
  return currentUpload;
}

/**
 * Put the operator's faces into the document at startup, and keep them there.
 *
 * TWO THINGS, and the first is the cold-load story. /api/config has not answered yet — it may never
 * answer, offline — so a device set to an operator face has nothing to render it with except the one
 * face `lib/design.ts` mirrored into storage when the reader picked it. Injecting that mirror here,
 * before the network, is what makes the swap happen ONCE ever rather than on every launch. The
 * server's rows supersede it wholesale as soon as they land (see {@link loadOperatorCommands}),
 * which is how a face the operator DELETED stops rendering.
 *
 * The second is the subscription: `--font-operator-family` has to be rewritten when the reader moves
 * onto or off an operator face, and `lib/design.ts` deliberately does not know the face list. This
 * module does, so the wiring lives here. Called once from main.tsx, after `initDesign`.
 */
export function initOperatorFonts(): void {
  const stored = designPrefs();
  // Only as a seed, and only while nothing better exists: `acceptOperatorFonts` re-validates it
  // exactly as if it had come off the wire, because a localStorage blob is no more trustworthy than
  // a response — it is the same string, one page load later.
  if (currentFonts.length === 0 && stored.operatorFont !== undefined) {
    currentFonts = acceptOperatorFonts([stored.operatorFont]);
  }
  applyOperatorFonts(currentFonts, stored.font);
  subscribeDesign(() => applyOperatorFonts(currentFonts, designPrefs().font));
}

export function subscribeOperatorConfig(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/**
 * Reactive read. Kicks the one-shot fetch on mount, so the only thing a call site has to do is read
 * the value — there is no "load this somewhere at startup" step to forget.
 */
export function useOperatorCommands(): readonly OperatorCommand[] {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  return useSyncExternalStore(subscribeOperatorConfig, getOperatorCommands, getOperatorCommands);
}

/** Reactive read of the Keys-tray presets. Same one-shot fetch, same contract. */
export function useOperatorKeys(): readonly OperatorKeyRow[] {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  return useSyncExternalStore(subscribeOperatorConfig, getOperatorKeys, getOperatorKeys);
}

/** Reactive read of the operator's typefaces. Same one-shot fetch, same contract. */
export function useOperatorFonts(): readonly OperatorFontFace[] {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  return useSyncExternalStore(subscribeOperatorConfig, getOperatorFonts, getOperatorFonts);
}

/** Reactive read of the attachment limits. Same one-shot fetch, same contract. */
export function useUploadCapability(): UploadCapability | null {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  return useSyncExternalStore(subscribeOperatorConfig, getUploadCapability, getUploadCapability);
}

/** Reactive read of the Quick-dock groups. Same one-shot fetch, same contract. */
export function useOperatorQuickReplies(): readonly OperatorQuickReplyRow[] {
  useEffect(() => {
    void loadOperatorCommands();
  }, []);
  return useSyncExternalStore(
    subscribeOperatorConfig,
    getOperatorQuickReplies,
    getOperatorQuickReplies,
  );
}

/** Test helper — reset module state between cases. */
export function __resetOperatorCommands(): void {
  hostMux.clear();
  hostMuxInflight.clear();
  current = [];
  currentKeys = [];
  currentReplies = [];
  currentFonts = [];
  currentMux = null;
  currentStt = null;
  currentUpload = null;
  inflight = null;
  loaded = false;
  listeners.clear();
}
