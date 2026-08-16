import { useEffect, useRef, useState } from "react";
import { CheckCircle2, LogIn, RefreshCw, RotateCw, TriangleAlert } from "lucide-react";
import { useRevalidator } from "react-router";

import { Button, buttonVariants } from "@/components/ui/button";
import { PROXY_AUTH_PATH } from "@/lib/sw-routes";
import { cn } from "@/lib/utils";
import type { BridgeStatus } from "@/lib/types";

interface FreshnessBannerProps {
  /** Herdr dependency state from this root snapshot only. */
  bridge: BridgeStatus | undefined;
  snapshotStale: boolean;
  snapshotAuthError: boolean;
  snapshotHasLastGood: boolean;
}

type View =
  | { kind: "auth"; copy: string; tone: "blocked" }
  | { kind: "stale"; copy: string; tone: "working" }
  | { kind: "herdr"; copy: string; tone: "blocked" }
  | { kind: "resumed"; copy: string; tone: "done" };

/** How long a genuine root-snapshot recovery confirmation remains visible. */
export const RESUMED_MS = 1_800;
/** Matches the collapse/fade transition so the row unmounts after its exit animation. */
export const EXIT_MS = 200;

// Root snapshot freshness has one top-level surface. It is intentionally driven only by the root
// loader's current result: pane reads, generic navigation loading, and voice work never alter it.
export function FreshnessBanner({
  bridge,
  snapshotStale,
  snapshotAuthError,
  snapshotHasLastGood,
}: FreshnessBannerProps) {
  const revalidator = useRevalidator();
  const staleCached = snapshotStale && !snapshotAuthError && snapshotHasLastGood;
  const wasVisibleStale = useRef(false);
  const [resumed, setResumed] = useState(false);

  useEffect(() => {
    const recovered =
      wasVisibleStale.current &&
      !snapshotStale &&
      !snapshotAuthError &&
      bridge === "connected";
    wasVisibleStale.current = staleCached;

    if (!recovered) {
      if (snapshotStale || snapshotAuthError || bridge !== "connected") setResumed(false);
      return;
    }

    setResumed(true);
    const id = window.setTimeout(() => setResumed(false), RESUMED_MS);
    return () => clearTimeout(id);
  }, [bridge, snapshotAuthError, snapshotStale, staleCached]);

  const view: View | null = snapshotAuthError
    ? { kind: "auth", copy: "Access refused.", tone: "blocked" }
    : snapshotStale
      ? {
          kind: "stale",
          copy: snapshotHasLastGood
            ? "Live updates delayed — showing the last update."
            : "Live updates delayed.",
          tone: "working",
        }
      : bridge === "disconnected"
        ? { kind: "herdr", copy: "Herdr unavailable.", tone: "blocked" }
        : resumed
          ? { kind: "resumed", copy: "Live updates resumed", tone: "done" }
          : null;

  return <AnimatedFreshnessRow view={view} onRetry={() => revalidator.revalidate()} />;
}

/** Pane-specific freshness is rendered at the pane, not promoted to a global status store. */
export function PaneFreshnessNotice({
  paneStale,
  paneAuthError,
  paneHasLastGood,
}: {
  paneStale: boolean;
  paneAuthError: boolean;
  paneHasLastGood: boolean;
}) {
  if (paneAuthError) {
    return (
      <div
        role="alert"
        aria-live="polite"
        className={cn("flex items-center gap-2 border-b px-3 py-1.5 text-xs", TINT.blocked.row)}
      >
        <TriangleAlert className={cn("size-3.5 shrink-0", TINT.blocked.icon)} />
        <span className="min-w-0 flex-1 truncate font-medium text-foreground">Pane access refused.</span>
        <SignInLink />
      </div>
    );
  }
  if (!paneStale) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn("flex items-center gap-2 border-b px-3 py-1.5 text-xs", TINT.working.row)}
    >
      <TriangleAlert className={cn("size-3.5 shrink-0", TINT.working.icon)} />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">
        {paneHasLastGood
          ? "Pane output delayed — showing the last update."
          : "Pane output delayed."}
      </span>
    </div>
  );
}

function AnimatedFreshnessRow({ view, onRetry }: { view: View | null; onRetry: () => void }) {
  const present = view !== null;
  const [rendered, setRendered] = useState(present);
  const [open, setOpen] = useState(false);
  const shownView = useRef<View>(view ?? { kind: "stale", copy: "", tone: "working" });
  if (view) shownView.current = view;

  useEffect(() => {
    if (present) {
      setRendered(true);
      const id = window.setTimeout(() => setOpen(true), 0);
      return () => clearTimeout(id);
    }
    setOpen(false);
    const id = window.setTimeout(() => setRendered(false), EXIT_MS);
    return () => clearTimeout(id);
  }, [present]);

  if (!rendered) return null;
  const shown = shownView.current;
  const Icon = shown.kind === "resumed" ? CheckCircle2 : TriangleAlert;
  const tint = TINT[shown.tone];
  const needsRetry = shown.kind === "stale" || shown.kind === "herdr";

  return (
    <div
      className={cn(
        "grid shrink-0 overflow-hidden transition-all duration-200 ease-out motion-reduce:transition-none",
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div
          role={shown.kind === "auth" || shown.kind === "herdr" ? "alert" : "status"}
          aria-live="polite"
          className={cn(
            "flex items-center gap-2 border-b px-4 py-1 text-xs [padding-top:calc(env(safe-area-inset-top)_+_0.25rem)]",
            tint.row,
          )}
        >
          <Icon className={cn("size-3.5 shrink-0", tint.icon)} />
          <span className="min-w-0 flex-1 truncate font-medium text-foreground">{shown.copy}</span>
          {shown.kind === "auth" ? (
            <>
              <SignInLink />
              <ReloadButton />
            </>
          ) : needsRetry ? (
            <Button size="sm" className="h-6 gap-1 px-2 text-xs" onClick={onRetry}>
              <RotateCw className="size-3.5" />
              Retry
            </Button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SignInLink() {
  return (
    <a
      href={PROXY_AUTH_PATH}
      className={cn(buttonVariants({ size: "sm" }), "h-6 gap-1 px-2 text-xs no-underline")}
    >
      <LogIn className="size-3.5" />
      Sign in
    </a>
  );
}

function ReloadButton() {
  return (
    <Button
      size="icon"
      variant="ghost"
      aria-label="Reload"
      className="size-6 text-muted-foreground"
      onClick={() => window.location.reload()}
    >
      <RefreshCw className="size-3.5" />
    </Button>
  );
}

const TINT = {
  done: { row: "border-status-done/40 bg-status-done/15", icon: "text-status-done" },
  working: { row: "border-status-working/40 bg-status-working/15", icon: "text-status-working" },
  blocked: { row: "border-status-blocked/40 bg-status-blocked/15", icon: "text-status-blocked" },
} as const;
