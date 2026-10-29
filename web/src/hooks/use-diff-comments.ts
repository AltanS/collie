import { useCallback, useEffect, useRef, useState } from "react";

import { loadDiffComments, saveDiffComments } from "@/lib/diff-comment-store";
import type { DiffComment } from "@/lib/diff-comments";
import type { Scope } from "@/lib/scope";

/**
 * The Changes screen's batch of diff comments, kept in sessionStorage for the tab (lib/diff-comment-store.ts).
 * It reads the held batch on mount and again when the target changes (a different pane or space under
 * the same route element), and writes it back on every change. `nextId` hands out ids that do not
 * collide with a restored batch.
 */
export function useDiffComments(scope: Scope | undefined, target: string) {
  const [state, setState] = useState(() => ({ scope, target, comments: loadDiffComments(scope, target) }));
  // Another target: its batch replaces this one during render, before anything is drawn from the old.
  let held = state;
  if (state.scope !== scope || state.target !== target) {
    held = { scope, target, comments: loadDiffComments(scope, target) };
    setState(held);
  }

  const nextIdRef = useRef(1);
  for (const c of held.comments) if (c.id >= nextIdRef.current) nextIdRef.current = c.id + 1;

  const setComments = useCallback(
    (update: (current: DiffComment[]) => DiffComment[]) => {
      setState((current) => ({ ...current, comments: update(current.comments) }));
    },
    [],
  );

  // Written after the commit, never in the updater: an updater runs twice under StrictMode.
  useEffect(() => {
    saveDiffComments(held.scope, held.target, held.comments);
  }, [held.scope, held.target, held.comments]);

  const nextId = useCallback(() => nextIdRef.current++, []);
  return { comments: held.comments, setComments, nextId };
}
