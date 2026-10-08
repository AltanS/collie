import { useCallback, useEffect, useRef, useState } from "react";

import { useVisibleInterval } from "@/hooks/use-visible-interval";
import { getGithubWork, type GithubWorkAnswer } from "@/lib/api";
import { isAbortError } from "@/lib/loaders";
import type { Scope } from "@/lib/scope";

/**
 * How often an open GitHub screen, and the dashboard's footer line, ask again while visible. The
 * bridge caches for the same 60 s (ADR 0091), so a faster beat would only re-read its cache.
 */
export const GITHUB_REFRESH_MS = 60_000;

export interface GithubWorkState {
  /**
   * The last answer the machine gave. Kept through a failed read, so a list never blanks because one
   * request did not get through; `null` until the first answer, which is the screen's loading state.
   */
  answer: GithubWorkAnswer | null;
  /** The latest read did not reach the machine. With `answer` still set, the lists are the last ones. */
  failed: boolean;
}

export interface GithubWork extends GithubWorkState {
  /** True while a refresh the operator asked for is in flight: the only read that spins the button. */
  refreshing: boolean;
  /** Ask past the bridge's cache (`?fresh=1`); the bridge floors it at 10 s and keeps it single-flight. */
  refresh: () => void;
}

const NO_ANSWER: GithubWorkState = { answer: null, failed: false };

/**
 * The GitHub screen's own read (routes/github.tsx). Not a route loader, on purpose: a loader is
 * re-run on every root poll tick, and this read can wait seconds on the host's `gh`. It reads on
 * open, every {@link GITHUB_REFRESH_MS} while the page is visible (`useVisibleInterval`: stopped
 * while hidden or behind the idle lock), and on the refresh button with `fresh`. One read at a time:
 * a beat that finds one in flight is skipped, and a refresh replaces whatever is in flight, since it
 * asks a newer question. `enabled` is false when the answer is handed in (the playground).
 *
 * The caller keys it by scope, so another machine starts from nothing rather than showing the last
 * machine's lists under the new one's name.
 */
export function useGithubWork(scope: Scope | undefined, enabled = true): GithubWork {
  const [state, setState] = useState<GithubWorkState>(NO_ANSWER);
  const [refreshing, setRefreshing] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const read = useRef<(fresh: boolean) => void>(() => {});
  useVisibleInterval(() => read.current(false), GITHUB_REFRESH_MS, enabled);

  useEffect(() => {
    if (!enabled) return undefined;
    let live = true;

    async function load(fresh: boolean) {
      if (!live) return;
      if (inFlight.current !== null) {
        if (!fresh) return;
        inFlight.current.abort();
      }
      const controller = new AbortController();
      inFlight.current = controller;
      if (fresh) setRefreshing(true);
      try {
        const answer = await getGithubWork(scope, { fresh, signal: controller.signal });
        if (live) setState({ answer, failed: false });
      } catch (e) {
        if (isAbortError(e) || !live) return;
        setState((prev) => (prev.failed ? prev : { answer: prev.answer, failed: true }));
      } finally {
        if (inFlight.current === controller) {
          inFlight.current = null;
          if (live) setRefreshing(false);
        }
      }
    }

    read.current = (fresh) => void load(fresh);
    void load(false);
    return () => {
      live = false;
      inFlight.current?.abort();
      inFlight.current = null;
      read.current = () => {};
    };
  }, [scope, enabled]);

  const refresh = useCallback(() => read.current(true), []);
  return { ...state, refreshing, refresh };
}

/**
 * The dashboard footer's look at GitHub work: `?peek=1` only, which never makes the bridge run `gh`
 * (ADR 0091). It answers `off`, `cold` or the cached lists, so drawing the footer line costs the
 * operator's GitHub nothing. Read on mount, when the scope changes, and on the same visible beat as
 * the screen. A failed peek keeps the last answer: a footer line has nothing useful to say about an
 * outage, and the connection banner already says it.
 */
export function useGithubPeek(scope: Scope | undefined): GithubWorkAnswer | null {
  const [answer, setAnswer] = useState<GithubWorkAnswer | null>(null);
  const read = useRef<() => void>(() => {});
  useVisibleInterval(() => read.current(), GITHUB_REFRESH_MS);

  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;

    async function peek() {
      if (inFlight || controller.signal.aborted) return;
      inFlight = true;
      try {
        setAnswer(await getGithubWork(scope, { peek: true, signal: controller.signal }));
      } catch {
        // See the header: keep what the line already says.
      } finally {
        inFlight = false;
      }
    }

    read.current = () => void peek();
    void peek();
    return () => {
      controller.abort();
      read.current = () => {};
    };
  }, [scope]);

  return answer;
}
