import { useEffect, useRef, useState } from "react";
import { Maximize2, Monitor, Pencil, ScrollText, Search, XCircle } from "lucide-react";

import { BottomSheet } from "@/components/ui/sheet";
import { ActionRow, DestructiveActionRow, RenameView } from "@/components/action-sheet-rows";
import { HostChip } from "@/components/host-chip";
import { useHostWriteBlock, usePack } from "@/components/pack-provider";
import { useActionEcho } from "@/hooks/use-action-echo";
import { usePendingConfirm } from "@/hooks/use-pending-confirm";
import { useLocale } from "@/hooks/use-locale";
import * as api from "@/lib/api";
import { describeApiError, describeThrownError } from "@/lib/api-error-message";
import { t } from "@/lib/i18n";
import { useMuxCapability, useMuxName } from "@/lib/mux-capability";
import { setStatus } from "@/lib/status";
import { paneDisplayName } from "@/lib/types";
import type { AgentView } from "@/lib/types";
import type { Scope } from "@/lib/scope";

interface PaneActionsSheetProps {
  open: boolean;
  onClose: () => void;
  /** The pane these actions target. Null while nothing is selected (sheet closed). */
  pane: AgentView | null;
  /** Session scope for the rename/close writes (undefined = primary). */
  scope?: Scope;
  /** This device isn't authorised to write — show a read-only note instead of the actions. */
  readOnly?: boolean;
  /** Fired after a successful rename so the parent can revalidate (the label lands on the next poll). */
  onRenamed: () => void;
  /** Fired after a successful close, with the closed pane id — the parent navigates Home if it's the
   *  pane currently open, or revalidates so it drops out of the list. */
  onClosed: (paneId: string) => void;

  /* The READ rows. All are optional and all are omitted by the pane strip, because they only
   * mean anything for the pane you are LOOKING AT: "find in output" searches the buffer this screen
   * has already fetched, and a strip pill can open this sheet on a pane whose output was never
   * loaded. The pane header passes them; the strip does not. Each is `undefined` when the caller has
   * nothing to offer (no buffered output yet; no agent session, so no transcript; a device that never
   * asked for zen), and a row with no callback is HIDDEN — the same "a sheet is a list of things you
   * can do" rule the capability gates below follow. The sheet closes itself before firing any of
   * them, so the surface a row leads to (the header's find bar, the history route, the bare mirror)
   * is the only thing on screen when it arrives. */

  /** Open find-in-output. The pane header's find bar takes over the header row. */
  onFind?: () => void;
  /** Open the agent's own transcript. */
  onHistory?: () => void;
  /** Enter zen mode — hide every Collie surface and leave the mirror alone on the screen.
   *
   *  The THIRD read row, and it is gated twice through this one prop: `Settings → Zen mode` decides
   *  whether this phone offers zen at all, and the pane header only passes a callback when there is
   *  buffered output to look at. Absence IS the gate, exactly as it is for find and history above —
   *  a device that never asked for zen sees a sheet byte-identical to today's. */
  onZen?: () => void;
}

type Mode = "actions" | "rename";

// The actions for a single pane. TWO entry points, one sheet: long-pressing (or re-tapping) a pane
// pill in the strip, and the ⋮ button in the pane header — which is why find, history and zen live
// here rather than in a second menu of their own. The header used to spend two of its four slots on those
// two icons; the pane already had a menu, so they became rows in it.
// Rename (set/clear its label) and close (kill). Opens on an action-list view; rename is a second
// tap away so the sheet doesn't shove a keyboard-triggering input at you just to close a pane. The
// action rows + rename view are the SHARED pieces (action-sheet-rows) the tab sheet also uses, so the
// two stay identical. The label is user text rendered only into an <input> value / text node — never
// markup — so it stays within the pane-output XSS boundary. Both actions are writes, so under
// read-only they're replaced by a note.
export function PaneActionsSheet({
  open,
  onClose,
  pane,
  scope,
  readOnly = false,
  onRenamed,
  onClosed,
  onFind,
  onHistory,
  onZen,
}: PaneActionsSheetProps) {
  useLocale();
  const [mode, setMode] = useState<Mode>("actions");
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  // Close runs under the shared press echo (hooks/use-action-echo.ts) rather than a bare `closing`
  // boolean. The bare boolean acknowledged the tap with a spinner and NOTHING else; on success the
  // sheet slid away and the row itself did not disappear from the strip until the next poll landed
  // (up to ~1.5s later), so the gap between "I confirmed a kill" and any visible consequence was
  // long enough to re-tap. The echo closes that gap at the control: `run` buzzes and goes `pending`
  // synchronously with the tap, before any network wait. The ✓ phase is never reached here — the
  // success branch closes the sheet — and that is correct: the pane VANISHING is the outcome, and a
  // success `setStatus` on top of it would announce a fact the screen is already making.
  const closeEcho = useActionEcho();
  const { pending, confirm, reset } = usePendingConfirm();
  const inputRef = useRef<HTMLInputElement>(null);
  // Rename and close are writes, and both are §10.3 writes to a specific machine — the PANE's, read
  // off the row rather than from the ambient scope, because a pane's host is the only thing that
  // says where closing it kills a terminal. Undefined on a solo install and on a reachable host, so
  // this sheet is byte-identical to today everywhere except a pack with a quiet member.
  const hostBlock = useHostWriteBlock(pane?.host);
  // What the multiplexer underneath can actually do to a pane (M10/06) — asked per row, below.
  const canRename = useMuxCapability("renamePane");
  const canClose = useMuxCapability("closePane");
  const canFocus = useMuxCapability("setFocus");
  const [focusing, setFocusing] = useState(false);
  // The mux name for the "Focus in <mux>" row and its toast — see `focusMux` below for why this
  // is gated to panes on the LOCAL machine before it's trusted.
  const localMuxName = useMuxName();
  const { lead } = usePack();
  // `useMuxName()` always answers for the collie THIS PAGE IS RUNNING ON (its own `/api/config`,
  // never a peer's — see that hook's own comment). A pane's `host` is undefined on a solo install
  // and, on a pack, is the LEAD's own id for a lead-hosted pane (lib/types.ts's doc on `host`) — so
  // either of those means "focus" runs on the mux this page already knows the name of. A pane whose
  // `host` names some OTHER member may be driven by a different multiplexer entirely, and naming the
  // local one would be a guess dressed as a fact. `focusMux` is `""` in that case, which is also the
  // "bridge hasn't answered yet" case `useMuxName()` itself returns — both get the same generic,
  // never-wrong fallback copy below.
  const focusMux = pane?.host === undefined || pane.host === lead ? localMuxName : "";

  // Reset to the action list — and reprefill the label — whenever the sheet opens on a (new) pane,
  // AND whenever it closes, so reopening never lands you mid-rename. Intentionally NOT keyed on the
  // live label, so a background poll landing while you type can't clobber your edit.
  useEffect(() => {
    setMode("actions");
    if (!open) return;
    setLabel(pane?.paneLabel ?? "");
    reset();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, pane?.paneId]);

  // Autofocus the label input when rename mode opens, so the phone keyboard pops without a second tap.
  useEffect(() => {
    if (mode === "rename") inputRef.current?.focus();
  }, [mode]);

  async function save() {
    if (!pane || saving) return;
    const next = label.trim();
    setSaving(true);
    try {
      const res = await api.renamePane(pane.paneId, next, scope);
      if (res.ok) {
        setStatus(next ? t("paneActions.status.renamed") : t("paneActions.status.labelCleared"), "success");
        onRenamed();
        onClose();
      } else {
        setStatus(describeApiError(res, t("paneActions.status.renameFailed")), "error");
      }
    } catch (e) {
      setStatus(describeThrownError(e), "error");
    } finally {
      setSaving(false);
    }
  }

  // Two-tap: the first tap arms (row flips to "Tap again to close"), the second closes.
  //
  // The echo's `action` must resolve the bridge's verdict as a boolean, and BOTH failure branches
  // stay here rather than moving to `lib/mutate.ts`: this row already reports every refusal in its
  // own words (`closeFailed` is the fallback for a body that carried none), so it is not a swallow
  // site. `pane` is copied to a local first — narrowing does not survive into the async closure.
  async function requestClose() {
    if (!pane || closeEcho.pending) return;
    const target = pane;
    if (!confirm(target.paneId)) return;
    await closeEcho.run(target.paneId, async () => {
      try {
        const res = await api.closePane(target.paneId, scope);
        if (!res.ok) {
          setStatus(describeApiError(res, t("paneActions.status.closeFailed")), "error");
          return false;
        }
        onClose();
        onClosed(target.paneId);
        return true;
      } catch (e) {
        setStatus(describeThrownError(e), "error");
        return false;
      }
    });
  }

  /**
   * Put this pane on the operator's own screen.
   *
   * The ONE act in the app that moves a terminal nobody is holding, which is why it is a row you
   * tap and never a consequence of navigating (ADR 0031). No confirm: it is reversible by the
   * operator's own keyboard, unlike the close below it.
   *
   * The sheet closes on success, because the answer to "show it in the terminal" is on the other
   * screen and the operator is about to look there.
   */
  async function showInTerminal() {
    if (!pane || focusing) return;
    setFocusing(true);
    try {
      const res = await api.focusPane(pane.paneId, scope);
      if (res.ok) {
        setStatus(t("paneActions.focus.done"), "success");
        onClose();
      } else {
        setStatus(describeApiError(res, t("paneActions.focus.failed")), "error");
      }
    } catch (e) {
      setStatus(describeThrownError(e), "error");
    } finally {
      setFocusing(false);
    }
  }

  const confirming = !!pane && pending === pane.paneId;

  return (
    <BottomSheet
      open={open}
      onClose={onClose}
      title={
        pane ? (
          // Every row below acts on THIS pane on THIS machine — rename, close, focus — so the
          // machine belongs beside the name in the one place every one of those rows sits under:
          // the title. `HostChip` self-hides on a solo install (its own `multi` gate), so this
          // row is byte-identical to the old plain-string title everywhere except a pack.
          //
          // The pane name truncates; the host does not. `min-w-0 truncate` on the name plus
          // `HostChip`'s own `shrink-0` is what makes that trade: the host is short, bounded, and
          // is the disambiguator that makes "close" and "focus" safe to tap — a truncated machine
          // name is worse than a truncated pane name, because it is the half that keeps you from
          // acting on the wrong one.
          <span className="flex min-w-0 items-center gap-1.5">
            <span data-slot="pane-actions-title-name" className="min-w-0 truncate">
              {paneDisplayName(pane)}
            </span>
            <HostChip host={pane.host} variant="target" />
          </span>
        ) : (
          t("paneActions.title.fallback")
        )
      }
    >
      {/* The READ rows lead, and they sit OUTSIDE the read-only / host-unreachable gates below on
          purpose. Neither of those refusals is about them: find searches a buffer this phone already
          holds, and history opens a transcript the lead reads off its own disk — a device that may
          not write, or a member machine that has stopped answering, takes away nothing either one
          needs. Folding them under the gate would have made "the machine is quiet" the reason you
          cannot search the last output you got from it, which is precisely when you want to.
          They lead rather than trail because they are the cheap, repeatable, reversible half of this
          sheet; rename and close are the half you arrive at deliberately.
          Hidden in `rename` mode with the rest of the list — that view is a sub-screen, not a
          section. */}
      {mode === "actions" && (onFind || onHistory || onZen) && (
        <div className="mb-1 flex flex-col gap-1">
          {onFind && (
            <ActionRow
              icon={<Search className="size-4 shrink-0 text-muted-foreground" />}
              label={t("chat.find.label")}
              onClick={() => {
                // Close FIRST, then act. Both land in one React event, so the sheet unmounts in the
                // same commit that mounts the find bar — see the focus note in agent-chat.tsx.
                onClose();
                onFind();
              }}
            />
          )}
          {onHistory && (
            <ActionRow
              icon={<ScrollText className="size-4 shrink-0 text-muted-foreground" />}
              label={t("chat.history.label")}
              onClick={() => {
                onClose();
                onHistory();
              }}
            />
          )}
          {/* Zen trails find and history rather than leading them: it is the same family — "look at
              the output differently" — but it is the one row here that takes the whole screen over,
              so it is the deliberate tap at the end of the run rather than the first thing under the
              thumb. Close-then-act, for the reason the find row states: both land in one React
              event, so the sheet unmounts in the same commit the chrome starts leaving. */}
          {onZen && (
            <ActionRow
              icon={<Maximize2 className="size-4 shrink-0 text-muted-foreground" />}
              label={t("chat.zen.label")}
              onClick={() => {
                onClose();
                onZen();
              }}
            />
          )}
        </div>
      )}
      {readOnly ? (
        <p className="py-2 text-sm text-muted-foreground">{t("paneActions.readOnly")}</p>
      ) : hostBlock ? (
        // Refused BEFORE anything is attempted (§10.3): no queue, no retry, no "try anyway" — the
        // lead would answer `host_unreachable` and the operator would be left guessing whether a
        // close half-landed. Offering the actions greyed out would suggest they're one tap from
        // working; naming the machine and its last-seen age says what to actually wait for.
        <p className="py-2 text-sm text-muted-foreground">
          {t("paneActions.hostBlockSuffix", { hostBlock })}
        </p>
      ) : mode === "actions" ? (
        <div className="flex flex-col gap-1">
          {/* Close kills a real terminal, and on a pack the sheet says which machine's — but that
              chip now lives in the TITLE row above (beside the pane name), since every row here,
              not just Close, acts on this pane's machine. Nothing to render here on its own. */}
          {/* Each row asks its OWN capability, not one "can this sheet do things" flag: a
              multiplexer that renames but will not close is an ordinary shape, and a single gate
              would take the other row down with it. A row a multiplexer cannot back is HIDDEN — the
              sheet is a list of things you can do, and a permanently dead entry in it is worse than
              a shorter list (the same argument the host block above makes about greying out). Both
              rows are present on every adapter shipped today. */}
          {canRename.capable && (
            <ActionRow
              icon={<Pencil className="size-4 shrink-0 text-muted-foreground" />}
              label={t("paneActions.rename.label")}
              onClick={() => setMode("rename")}
            />
          )}
          {canFocus.capable && (
            <ActionRow
              icon={<Monitor className="size-4 shrink-0 text-muted-foreground" />}
              label={
                focusMux
                  ? t("paneActions.focus.labelWithMux", { mux: focusMux })
                  : t("paneActions.focus.labelFallback")
              }
              onClick={() => void showInTerminal()}
            />
          )}
          {canClose.capable && (
            <DestructiveActionRow
              icon={<XCircle className="size-4 shrink-0" />}
              label={t("paneActions.close.label")}
              confirmLabel={t("paneActions.close.confirm")}
              closingLabel={t("paneActions.close.closing")}
              armed={confirming}
              // `pending` rather than `phaseOf(id)`: close is the only member of this echo group,
              // so the group flag says the same thing without needing a pane that may be null here.
              closing={closeEcho.pending}
              onClick={() => void requestClose()}
            />
          )}
          {/* An EMPTY sheet is the one case that must speak. Long-pressing a pane and being handed
              a blank box says nothing at all, so when every row is gone the adapter's own reason
              takes their place — hide the meaningless, explain the expected. */}
          {!canRename.capable && !canClose.capable && !canFocus.capable && (
            <p className="py-2 text-sm leading-snug text-muted-foreground">
              {canRename.note || canClose.note || canFocus.note || t("paneActions.empty.fallback")}
            </p>
          )}
        </div>
      ) : (
        <RenameView
          inputRef={inputRef}
          label={label}
          onLabelChange={setLabel}
          onSave={() => void save()}
          onBack={() => setMode("actions")}
          saving={saving}
          // A blank pane field clears the label (blank → null on the bridge), so Save stays enabled.
          canSave={true}
          placeholder={t("paneActions.rename.placeholder")}
        />
      )}
    </BottomSheet>
  );
}
