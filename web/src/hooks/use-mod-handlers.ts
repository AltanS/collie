import { useCallback, useMemo, useRef, useState } from "react";

import { useNav } from "@/hooks/use-nav";
import { loadDraft, saveDraft } from "@/lib/drafts";
import { paneScope } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import { draftPlacement, findModSession, findScopedPane, isModPane } from "@/lib/mods/places";
import { isModSessionId, type OpenTarget } from "@/lib/mods/schema";
import type { DraftRequest } from "@/lib/mods/store";
import { modSessionPath, panePath } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { paneScopeKey } from "@/lib/scope";
import { setStatus } from "@/lib/status";
import type { AgentView } from "@/lib/types";

// WHERE A MOD'S DRAFT AND OPEN GO (M94 slice 03). One hook for every place a mod draws a control:
// the belt's marks on a pane, and the view on a mod session's screen.
//
// THE DRAFT RULE (design section 8): a draft goes to a REAL session's reply box and fills it only when
// it is empty. A box with text keeps its text, and the toast says the draft was not placed. The pane
// open on the phone is filled in place through its composer; another pane is opened, one level down,
// with the draft waiting in its box (the composer restores the draft store on mount). A draft with no
// session (the frame's "Ask the agent to fix it") goes to the pane open now, else to the one the
// person picks in a sheet.
//
// THE OPEN RULE: a session opens one level down, so back comes here; a URL opens in a new tab, with
// `noopener`, and the phone stays where it is.

/** The pane open on the phone, with the way into its reply box. */
export interface CurrentPane {
  pane: AgentView;
  /**
   * The mounted composer's `placeDraft`: true placed, false refused (the box holds text). Undefined, or
   * a call that returns undefined: no composer is mounted, and the draft store is the box.
   */
  place?: (text: string) => boolean | undefined;
}

/** A draft that waits for the person to pick its session. */
export interface PendingDraft {
  text: string;
  modsHost: string;
}

export interface ModHandlers {
  /** The handlers for one part, by the host its mod runs on (the part key's first piece). */
  handlersFor: (modsHost: string) => { onDraft: (draft: DraftRequest) => void; onOpen: (target: OpenTarget) => void };
  /** A draft with no session, while the sheet asks which one. */
  pending: PendingDraft | undefined;
  /** The sessions the sheet offers: every real pane, mod sessions never. */
  choices: readonly AgentView[];
  /** The person picked a session for the pending draft. */
  choose: (pane: AgentView) => void;
  cancel: () => void;
}

const NO_PANES: readonly AgentView[] = [];

export function useModHandlers(current?: CurrentPane): ModHandlers {
  const data = useOptionalRootData();
  const nav = useNav();
  const [pending, setPending] = useState<PendingDraft | undefined>(undefined);
  // Read through a ref, so the handlers a view holds stay one function across polls.
  const live = useRef({ data, current, nav });
  live.current = { data, current, nav };


  const placeIn = useCallback((target: AgentView, text: string) => {
    const { data: root, current: here, nav: go } = live.current;
    if (root === undefined) return;
    const scope = paneScope(root.scope, target, root.servers, root.sessions);
    const key = paneScopeKey(scope, target.paneId);
    const open = here !== undefined && paneScopeKey(paneScope(root.scope, here.pane, root.servers, root.sessions), here.pane.paneId) === key;
    const placed = open ? here.place?.(text) : undefined;
    if (placed === true) return;
    if (placed === false) {
      setStatus(t("mods.draft.boxHasText"), "warn");
      return;
    }
    if (draftPlacement(loadDraft(scope, target.paneId), target) !== "placed") {
      setStatus(t("mods.draft.boxHasText"), "warn");
      return;
    }
    saveDraft(scope, target.paneId, text);
    if (!open) go.down(panePath(target.paneId, scope));
  }, []);

  const handlersFor = useCallback(
    (modsHost: string) => ({
      onDraft: (draft: DraftRequest) => {
        const { current: here } = live.current;
        if (draft.session === undefined) {
          if (here !== undefined && !isModPane(here.pane)) placeIn(here.pane, draft.text);
          else setPending({ text: draft.text, modsHost });
          return;
        }
        const target = findScopedPane(draft.session, panesOf(live.current.data), modsHost);
        if (target === undefined) {
          setStatus(t("mods.draft.gone"), "warn");
          return;
        }
        placeIn(target, draft.text);
      },
      onOpen: (target: OpenTarget) => {
        if (target.url !== undefined) {
          window.open(target.url, "_blank", "noopener,noreferrer");
          return;
        }
        const { data: root, nav: go } = live.current;
        if (root === undefined) return;
        if (isModSessionId(target.session)) {
          const found = findModSession(target.session, root.modSessions ?? NO_PANES);
          if (found === undefined) setStatus(t("mods.draft.gone"), "warn");
          else go.down(modSessionPath(found.paneId));
          return;
        }
        const pane = findScopedPane(target.session, panesOf(root), modsHost);
        if (pane === undefined) {
          setStatus(t("mods.draft.gone"), "warn");
          return;
        }
        go.down(panePath(pane.paneId, paneScope(root.scope, pane, root.servers, root.sessions)));
      },
    }),
    [placeIn],
  );

  const choose = useCallback(
    (pane: AgentView) => {
      const draft = pending;
      setPending(undefined);
      if (draft !== undefined) placeIn(pane, draft.text);
    },
    [pending, placeIn],
  );
  const cancel = useCallback(() => setPending(undefined), []);

  // The sheet's rows are read only while it asks, so a screen with no pending draft reads nothing.
  const choices = useMemo(() => (pending === undefined ? NO_PANES : panesOf(data)), [pending, data]);
  return { handlersFor, pending, choices, choose, cancel };
}

function panesOf(data: ReturnType<typeof useOptionalRootData>): readonly AgentView[] {
  return data === undefined ? NO_PANES : [...data.agents, ...data.shellPanes];
}
