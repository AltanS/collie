import { useEffect, useRef, useState } from "react";

import { fieldProblemWords } from "@/components/trick-settings-group";
import { addOfficialTrick, apiErrorFields, apiErrorStatus, fetchOfficialTricks, setTrickAuto, setTrickValue, switchTrick, undoTrick } from "@/lib/api";
import { t } from "@/lib/i18n";
import type { FieldValue, OfficialState, OfficialTricksReply, WireOfficialTrick, WireTrickInfo } from "@/lib/tricks/schema";
import { setStatus } from "@/lib/status";
import { mintRequestId } from "@/lib/worktree-name";

// THE WRITES OF SETTINGS, TRICKS, shared by the list (components/tricks-settings-card.tsx) and a trick's details page
// (routes/settings-trick.tsx). Moved here from the card unchanged when the About sheet became a page (2026-11-21), so
// the two places that switch a trick on, flip its "Update this trick without asking", save its settings and add an official
// trick do it with one code path:
//
//   * A SWITCH FLIPS AT ONCE and holds the new position until the store's list agrees (`HOLD_MS` at most). A switch on
//     sends the code hash the trick was shown with (`approves`, review 8 V-N1), and the bridge refuses a switch on that
//     names another. A refused or lost post puts the switch back and says so in the status line.
//   * The auto switch holds the same way, and says a failed write once.
//   * A setting edit carries one request id per edit, so a retry of the same edit writes once (review G, point 6).
//   * An official add or update keeps its spinner until the trick shows among the installed ones.
//
// Each caller holds its own instance: the held positions are a screen's, not the app's.

/** How long a flipped switch keeps its position while the store's list has not caught up. */
export const HOLD_MS = 20_000;

/** How long after the first answer the card reads the list once more, when it lacked a repository's facts. */
export const FACTS_REREAD_MS = 3000;

const trickKey = (trick: Pick<WireTrickInfo, "host" | "id">): string => `${trick.host}/${trick.id}`;

/** The status line for a failed add or update, from the bridge's `error` word. */
export function officialFailureLine<TThrown>(thrown: TThrown, mode: "add" | "update", name: string): string {
  const code = apiErrorFields(thrown)?.error;
  const add = mode === "add";
  if (code === "unreachable") return t(add ? "settings.tricks.official.unreachable" : "settings.tricks.official.updateUnreachable");
  // A repository that sent more than a listed commit can be is the same class of refusal as a mismatch.
  if (code === "mismatch" || code === "too-large") return t(add ? "settings.tricks.official.mismatch" : "settings.tricks.official.updateMismatch");
  // A POSIX trick (a shell run line) on a Windows machine (fault d): the same words as the switch's refusal.
  if (code === "windows-shell") return t("settings.tricks.switchShellOnWindows");
  if (code === "busy") return t("settings.tricks.official.busy");
  if (code === "taken") return t("settings.tricks.official.taken");
  // The new code needs a name the person's own files hold in the trick's folder: nothing was changed.
  if (code === "blocked" && !add) return t("settings.tricks.official.updateBlocked");
  // A version of the list whose files the person changed: Collie never moves or removes them.
  if (code === "changed") return t("settings.tricks.official.changed");
  return add ? t("settings.tricks.official.failed", { name }) : t("settings.tricks.official.updateFailed", { name });
}

/** The calls the writes make. The real routes by default; a test or the playground passes its own. */
export interface TrickWriteCalls {
  onSwitch?: (host: string, id: string, on: boolean, hash?: string) => Promise<WireTrickInfo>;
  onAuto?: (host: string, id: string, on: boolean) => Promise<WireTrickInfo>;
  onUndo?: (host: string, id: string) => Promise<WireTrickInfo>;
  onSetValue?: (host: string, id: string, body: { rid: string; key: string; value: FieldValue | null }) => Promise<WireTrickInfo>;
  onOfficialAdd?: (id: string, mode: "add" | "update") => Promise<{ id: string; state: OfficialState }>;
}

/** What a screen holds of the official list. */
export interface OfficialListState {
  list: OfficialTricksReply | null;
  /** The first read answered or failed: the rows may be drawn in their order. */
  settled: boolean;
  reread: () => void;
}

/** Whether an entry's repository is one the bridge reads facts for and none came yet. */
function factsDue(list: OfficialTricksReply): boolean {
  return list.tricks.some((entry) => entry.repoFacts === undefined && hostOf(entry.repo) === "github.com");
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

/**
 * The official list as the card shows it: read once on mount and again whenever the installed tricks
 * change (an id or a commit), or when `reread` asks. A read that fails keeps what the card had, and the
 * first one that fails leaves no list: the rows are then ordered by name with no label. When the first
 * answer lacks a GitHub repository's facts, the bridge is reading them in the background (repo-facts.ts):
 * the card reads the list ONCE more after {@link FACTS_REREAD_MS}, never again, so a failed read upstream
 * costs one more read of the bridge's own folder and nothing else.
 */
export function useOfficialList(read: (signal?: AbortSignal) => Promise<OfficialTricksReply> = fetchOfficialTricks, tricks: readonly WireTrickInfo[]): OfficialListState {
  const [list, setList] = useState<OfficialTricksReply | null>(null);
  const [settled, setSettled] = useState(false);
  const [asked, setAsked] = useState(0);
  const installed = tricks.map((trick) => `${trick.id}@${trick.provenance?.sha ?? ""}`).join(",");
  const reader = useRef(read);
  reader.current = read;
  const factsAsked = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const reply = await reader.current(controller.signal);
        if (controller.signal.aborted) return;
        setList(reply);
        if (factsAsked.current || !factsDue(reply)) return;
        factsAsked.current = true;
        const timer = setTimeout(() => setAsked((n) => n + 1), FACTS_REREAD_MS);
        controller.signal.addEventListener("abort", () => clearTimeout(timer));
      } catch {
        // A failed read keeps what the card had.
      } finally {
        if (!controller.signal.aborted) setSettled(true);
      }
    })();
    return () => controller.abort();
  }, [installed, asked]);
  return { list, settled, reread: () => setAsked((n) => n + 1) };
}

export interface TrickWrites {
  /** The switch's position for a trick: the held one while a flip waits for the list, else the wire's. */
  checkedOf: (trick: WireTrickInfo) => boolean;
  /** The auto switch's position for a trick, the same way. */
  autoOf: (trick: WireTrickInfo) => boolean;
  undoing: (trick: WireTrickInfo) => boolean;
  /** The official adds and updates in flight or held until the lists agree, by trick id. */
  adding: ReadonlyMap<string, "add" | "update">;
  flip: (trick: WireTrickInfo, on: boolean) => Promise<void>;
  flipAuto: (trick: WireTrickInfo, on: boolean) => Promise<void>;
  undo: (trick: WireTrickInfo) => Promise<void>;
  saveValue: (trick: WireTrickInfo, key: string, value: FieldValue | null) => Promise<string | null>;
  addOfficial: (entry: WireOfficialTrick, mode: "add" | "update") => Promise<void>;
}

/** The writes of one screen of Settings, Tricks and the Hill, against the store's `tricks` and the official list it read. */
export function useTrickWrites(calls: TrickWriteCalls, tricks: readonly WireTrickInfo[], official: OfficialListState): TrickWrites {
  const { onSwitch = switchTrick, onAuto = setTrickAuto, onUndo = undoTrick, onSetValue = setTrickValue, onOfficialAdd = addOfficialTrick } = calls;
  // The position a flipped switch holds until the list agrees, and the switches with a post in flight
  // (a second tap on one of those does nothing; the switch itself stays drawn the same).
  const [held, setHeld] = useState<ReadonlyMap<string, boolean>>(new Map());
  // The same for the take-changes-without-asking switch, and the Undo posts in flight.
  const [heldAuto, setHeldAuto] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [undoing, setUndoing] = useState<ReadonlySet<string>>(new Set());
  const flying = useRef(new Set<string>());
  // The request id of each setting edit that has not taken yet, by `host/trick/field` (see `saveValue`).
  const valueEdits = useRef(new Map<string, { value: FieldValue | null; rid: string }>());
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  const [adding, setAdding] = useState<ReadonlyMap<string, "add" | "update">>(new Map());

  useEffect(() => {
    const open = timers.current;
    return () => {
      for (const timer of open) clearTimeout(timer);
      open.clear();
    };
  }, []);

  // The list caught up with a position that was held: the store speaks again.
  useEffect(() => {
    const caughtUp = tricks.filter((trick) => held.get(trickKey(trick)) === trick.on).map(trickKey);
    if (caughtUp.length === 0) return;
    setHeld((was) => {
      const next = new Map(was);
      for (const key of caughtUp) next.delete(key);
      return next;
    });
  }, [tricks, held]);

  // The list caught up with an auto position that was held.
  useEffect(() => {
    const caughtUp = tricks.filter((trick) => heldAuto.get(trickKey(trick)) === (trick.auto === true)).map(trickKey);
    if (caughtUp.length === 0) return;
    setHeldAuto((was) => {
      const next = new Map(was);
      for (const key of caughtUp) next.delete(key);
      return next;
    });
  }, [tricks, heldAuto]);

  function holdAuto(key: string, on: boolean | null): void {
    setHeldAuto((was) => {
      const next = new Map(was);
      if (on === null) next.delete(key);
      if (on !== null) next.set(key, on);
      return next;
    });
  }

  async function flipAuto(trick: WireTrickInfo, on: boolean): Promise<void> {
    const key = `auto:${trickKey(trick)}`;
    if (flying.current.has(key)) return;
    holdAuto(trickKey(trick), on);
    flying.current.add(key);
    try {
      const info = await onAuto(trick.host, trick.id, on);
      holdAuto(trickKey(trick), info.auto === true);
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        holdAuto(trickKey(trick), null);
      }, HOLD_MS);
      timers.current.add(timer);
    } catch {
      holdAuto(trickKey(trick), null);
      setStatus(t("settings.tricks.auto.failed", { name: trick.name }), "error");
    } finally {
      flying.current.delete(key);
    }
  }

  // A trick's setting (contract 3): one request id per edit, so a retry of the same edit (the same trick,
  // field and value, after a failure) reuses it and the bridge writes once. A new edit, or the same value
  // again after the write took, gets a new id. The receipt is the row the list will show; the group holds
  // the value until the list agrees. A refusal is said under the field in the phone's words, never the
  // bridge's English.
  async function saveValue(trick: WireTrickInfo, key: string, value: FieldValue | null): Promise<string | null> {
    const field = trick.fields?.find((one) => one.key === key);
    const editKey = `${trick.host}/${trick.id}/${key}`;
    const earlier = valueEdits.current.get(editKey);
    const rid = earlier !== undefined && earlier.value === value ? earlier.rid : mintRequestId();
    valueEdits.current.set(editKey, { value, rid });
    try {
      await onSetValue(trick.host, trick.id, { rid, key, value });
      valueEdits.current.delete(editKey);
      return null;
    } catch (err) {
      // A field rule rides in `code`; a refusal of the route itself (`not-here`) in `error`.
      const fields = apiErrorFields(err);
      const code = fields?.code ?? fields?.error;
      if (code === "unknown-field" || field === undefined) return t("settings.tricks.fields.refused.gone");
      if (code === "not-here") return t("settings.tricks.fields.onLead");
      if (code === "kind" || code === "text" || code === "option" || code === "range" || code === "whole") return fieldProblemWords(field, { code });
      return t("settings.tricks.fields.failed", { label: field.label });
    }
  }

  async function undo(trick: WireTrickInfo): Promise<void> {
    const key = trickKey(trick);
    if (undoing.has(key)) return;
    setUndoing((was) => new Set(was).add(key));
    try {
      // The row is the receipt: the line goes once the list shows the earlier version.
      await onUndo(trick.host, trick.id);
    } catch {
      setStatus(t("settings.tricks.undoFailed", { name: trick.name }), "error");
    } finally {
      setUndoing((was) => {
        const next = new Set(was);
        next.delete(key);
        return next;
      });
    }
  }

  function hold(key: string, on: boolean | null): void {
    setHeld((was) => {
      const next = new Map(was);
      if (on === null) next.delete(key);
      if (on !== null) next.set(key, on);
      return next;
    });
  }

  async function flip(trick: WireTrickInfo, on: boolean): Promise<void> {
    const key = trickKey(trick);
    if (flying.current.has(key)) return;
    hold(key, on);
    flying.current.add(key);
    try {
      const info = on && trick.approves !== undefined ? await onSwitch(trick.host, trick.id, on, trick.approves) : await onSwitch(trick.host, trick.id, on);
      hold(key, info.on);
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        hold(key, null);
      }, HOLD_MS);
      timers.current.add(timer);
    } catch (thrown) {
      hold(key, null);
      // The trick changed after the person read it (review 8 V-N1): read it again, nothing was approved.
      const code = apiErrorFields(thrown)?.error;
      // A Windows machine refuses a shell run line (fault d); the bridge's message is `TRICKS_WINDOWS_SHELL_LINE`.
      // The bridge cannot show every byte of the code as it is (`codeShowsWhole`, a 409 `not-whole`): it stays off, and the phone says why.
      const notWhole = code === "not-whole" && apiErrorStatus(thrown) === 409;
      const line = code === "moved" ? t("settings.tricks.switchMoved") : code === "windows-shell" ? t("settings.tricks.switchShellOnWindows") : notWhole ? t("settings.tricks.switchNotWhole") : t("settings.tricks.switchFailed", { name: trick.name });
      setStatus(line, "error");
    } finally {
      flying.current.delete(key);
    }
  }

  function release(id: string): void {
    setAdding((was) => {
      if (!was.has(id)) return was;
      const next = new Map(was);
      next.delete(id);
      return next;
    });
  }

  // An add is done when the trick is among the installed ones; an update when the list says it is added.
  // Until then the row keeps its spinner, so it never blinks out and back between the two lists.
  useEffect(() => {
    for (const [id, mode] of adding) {
      if (flying.current.has(`official:${id}`)) continue;
      const entry = official.list?.tricks.find((e) => e.id === id);
      const installed = tricks.some((trick) => trick.id === id);
      if (mode === "add" ? installed && entry?.state !== "absent" : entry?.state === "added") release(id);
    }
  }, [adding, official.list, tricks]);

  async function addOfficial(entry: WireOfficialTrick, mode: "add" | "update"): Promise<void> {
    const key = `official:${entry.id}`;
    if (flying.current.has(key) || adding.has(entry.id)) return;
    flying.current.add(key);
    setAdding((was) => new Map(was).set(entry.id, mode));
    try {
      await onOfficialAdd(entry.id, mode);
      // A hold that never sees the lists agree (a store that stopped polling) lets go after a while.
      const timer = setTimeout(() => {
        timers.current.delete(timer);
        release(entry.id);
      }, HOLD_MS);
      timers.current.add(timer);
    } catch (error) {
      release(entry.id);
      setStatus(officialFailureLine(error, mode, entry.name), "error");
    } finally {
      flying.current.delete(key);
      official.reread();
    }
  }

  return {
    checkedOf: (trick) => held.get(trickKey(trick)) ?? trick.on,
    autoOf: (trick) => heldAuto.get(trickKey(trick)) ?? trick.auto === true,
    undoing: (trick) => undoing.has(trickKey(trick)),
    adding,
    flip,
    flipAuto,
    undo,
    saveValue,
    addOfficial,
  };
}
