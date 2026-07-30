import type { ReactNode } from "react";
import { AlertCircle, Check, ChevronRight, ExternalLink, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";
import { SectionHeader } from "@/components/section-header";
import { SectionLabel } from "@/components/ui/section-label";
import { timeAgo } from "@/lib/format";
import type {
  FirstmateChecks,
  FirstmateEndpoint,
  FirstmateStatus,
  FirstmateUnavailableReason,
  SessionSummary,
} from "@/lib/types";

interface FirstmateOverviewProps {
  firstmate: FirstmateStatus | undefined;
  sessions: readonly SessionSummary[];
  onOpen: (paneId: string, session: string | undefined) => void;
}

const UNAVAILABLE_COPY: Record<FirstmateUnavailableReason, string> = {
  "not-executable": "Firstmate isn't set up on this host.",
  timeout: "Firstmate didn't respond in time.",
  "output-limit": "Firstmate's report was too large to read.",
  "command-failed": "Firstmate couldn't produce a report.",
  "invalid-output": "Firstmate's report couldn't be read.",
};

const CHECKS_DOT: Record<FirstmateChecks, string> = {
  passing: "bg-status-done",
  failing: "bg-status-blocked",
  pending: "bg-status-working",
  none: "bg-status-idle",
  unknown: "bg-status-unknown",
};

const CHECKS_LABEL: Record<FirstmateChecks, string> = {
  passing: "Checks passing",
  failing: "Checks failing",
  pending: "Checks pending",
  none: "No checks",
  unknown: "Checks unknown",
};

function resolveSession(session: string, sessions: readonly SessionSummary[]): string | undefined {
  const match = sessions.find((s) => s.name === session);
  return match?.isPrimary ? undefined : session;
}

function TaskRow({
  primary,
  secondary,
  badge,
  tone,
  endpoint,
  sessions,
  onOpen,
  external,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  badge?: ReactNode;
  tone: "attention" | "flat";
  endpoint?: FirstmateEndpoint;
  sessions: readonly SessionSummary[];
  onOpen: (paneId: string, session: string | undefined) => void;
  external?: { href: string; label: string };
}) {
  const Shell = tone === "attention" ? Card : "div";
  const shell = (
    <Shell
      className={cn(
        tone === "attention"
          ? "flex-row items-center gap-2 rounded-xl px-3 py-2.5 shadow-sm"
          : "flex flex-row items-center gap-2 px-2.5 py-2.5",
      )}
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium">{primary}</p>
        {secondary && <div className="truncate text-xs text-muted-foreground">{secondary}</div>}
      </div>
      {badge}
      {endpoint && <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
    </Shell>
  );

  return (
    <div className="flex items-center gap-1">
      {endpoint ? (
        <button
          type="button"
          onClick={() => onOpen(endpoint.paneId, resolveSession(endpoint.session, sessions))}
          className="min-w-0 flex-1 text-left transition-transform active:scale-[0.99]"
        >
          {shell}
        </button>
      ) : (
        <div className="min-w-0 flex-1">{shell}</div>
      )}
      {external && (
        <a
          href={external.href}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={external.label}
          className="flex shrink-0 items-center justify-center rounded-md p-2 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="size-3.5" aria-hidden />
        </a>
      )}
    </div>
  );
}

interface SectionSpec {
  key: string;
  label: string;
  dot?: string;
  accent?: boolean;
  tone: "attention" | "flat";
  rows: { key: string; node: ReactNode }[];
  note?: ReactNode;
  summary?: string;
  tag?: ReactNode;
}

function buildSections(
  data: Extract<FirstmateStatus, { state: "ready" | "stale" }>,
  sessions: readonly SessionSummary[],
  onOpen: (paneId: string, session: string | undefined) => void,
): SectionSpec[] {
  const prRows = data.prs.map((pr) => ({
    key: `${pr.repo}#${pr.number}`,
    node: (
      <TaskRow
        primary={`#${pr.number} · ${pr.repo}`}
        secondary={
          <>
            <span className="block truncate">{pr.task}</span>
            <span className="block truncate">
              {pr.review} · {pr.mergeable}
            </span>
          </>
        }
        badge={
          <span
            className="flex shrink-0 items-center"
            role="img"
            aria-label={CHECKS_LABEL[pr.checks]}
          >
            <span className={cn("size-2 rounded-full", CHECKS_DOT[pr.checks])} aria-hidden />
          </span>
        }
        tone="flat"
        endpoint={pr.endpoint}
        sessions={sessions}
        onOpen={onOpen}
        external={{ href: pr.url, label: `Open PR #${pr.number} in ${pr.repo} on GitHub` }}
      />
    ),
  }));

  const prNote: ReactNode | undefined =
    data.prState === "loading" ? (
      <span className="flex items-center gap-2">
        <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden />
        Checking PRs…
      </span>
    ) : data.prState === "unavailable" ? (
      <span className="flex items-center gap-2">
        <AlertCircle className="size-3.5 shrink-0" aria-hidden />
        Firstmate couldn't check PRs.
      </span>
    ) : undefined;

  const sections: SectionSpec[] = [
    {
      key: "decisions",
      label: "Needs you",
      dot: "bg-status-blocked",
      accent: true,
      tone: "attention",
      rows: data.decisions.map((d) => ({
        key: d.id,
        node: (
          <TaskRow
            primary={d.summary}
            secondary={`${d.id} · ${d.owner}`}
            tone="attention"
            endpoint={d.endpoint}
            sessions={sessions}
            onOpen={onOpen}
          />
        ),
      })),
    },
    {
      key: "inFlight",
      label: "In flight",
      dot: "bg-status-working",
      tone: "flat",
      rows: data.inFlight.map((t) => ({
        key: t.id,
        node: (
          <TaskRow
            primary={t.doing}
            secondary={`${t.id} · ${t.kind} · ${t.state}`}
            tone="flat"
            endpoint={t.endpoint}
            sessions={sessions}
            onOpen={onOpen}
          />
        ),
      })),
    },
    {
      key: "gates",
      label: "Gates",
      dot: "bg-status-blocked",
      tone: "attention",
      rows: data.gates.map((g) => ({
        key: g.id,
        node: (
          <TaskRow
            primary={g.title}
            secondary={`${g.id} · Blocked by ${g.blockedBy} — ${g.reason} · ${g.owner}`}
            tone="attention"
            endpoint={g.endpoint}
            sessions={sessions}
            onOpen={onOpen}
          />
        ),
      })),
    },
  ];

  sections.push({
    key: "prs",
    label: "PRs",
    tone: "flat",
    rows: prRows,
    note: prNote,
    summary: data.prSummary,
    tag:
      data.prState === "stale" ? (
        <span className="rounded-full bg-status-working/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-status-working">
          stale
        </span>
      ) : undefined,
  });

  sections.push({
    key: "landed",
    label: "Delivered",
    dot: "bg-status-done",
    tone: "flat",
    rows: data.landed.map((l) => ({
      key: l.id,
      node: (
        <TaskRow
          primary={l.what}
          secondary={`${l.id} · ${l.owner}`}
          tone="flat"
          sessions={sessions}
          onOpen={onOpen}
        />
      ),
    })),
  });

  return sections;
}

export function FirstmateOverview({ firstmate, sessions, onOpen }: FirstmateOverviewProps) {
  if (!firstmate) return null;

  if (firstmate.state === "loading") {
    return (
      <section className="flex flex-col gap-2 px-3 pt-4">
        <p className="flex items-center gap-2 px-1 py-1 text-sm text-muted-foreground">
          <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
          Loading Firstmate…
        </p>
      </section>
    );
  }

  if (firstmate.state === "unavailable") {
    return (
      <section className="flex flex-col gap-2 px-3 pt-4">
        <p className="flex items-center gap-2 px-1 py-1 text-sm text-muted-foreground">
          <AlertCircle className="size-4 shrink-0" aria-hidden />
          {UNAVAILABLE_COPY[firstmate.reason]}
        </p>
      </section>
    );
  }

  const stale = firstmate.state === "stale";
  const sections = buildSections(firstmate, sessions, onOpen).filter(
    (section) => section.rows.length > 0 || section.note || section.summary || section.tag,
  );
  const empty = sections.length === 0;
  const prStatus =
    firstmate.prState === "disabled"
      ? null
      : firstmate.prState === "loading"
        ? "Checking pull requests"
        : firstmate.prState === "unavailable"
          ? "Pull request check unavailable"
          : firstmate.prState === "stale"
            ? `Pull request data stale${firstmate.prSummary ? `: ${firstmate.prSummary}` : ""}`
            : `Pull request check complete${firstmate.prSummary ? `: ${firstmate.prSummary}` : ""}`;

  return (
    <section className="flex flex-col gap-5 px-3 pt-4">
      <div className="flex items-center justify-between gap-2 px-1">
        <SectionLabel>Firstmate</SectionLabel>
        <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
          {stale && (
            <span
              className="rounded-full bg-status-working/15 px-2 py-0.5 font-semibold uppercase tracking-wide text-status-working"
              role="status"
            >
              stale
            </span>
          )}
          <span className="tabular-nums">{timeAgo(Date.parse(firstmate.generatedAt))}</span>
        </div>
      </div>
      {prStatus && (
        <span className="sr-only" role="status" aria-live="polite">
          {prStatus}
        </span>
      )}

      {empty ? (
        <p className="flex items-center gap-2 px-1 text-sm font-medium">
          <Check className="size-5 shrink-0 text-status-done" aria-hidden />
          Nothing to report
        </p>
      ) : (
        sections.map((s) => (
          <section key={s.key} className="flex flex-col gap-2">
            <SectionHeader
              label={s.label}
              count={s.rows.length > 0 ? s.rows.length : undefined}
              {...(s.dot ? { dot: s.dot } : {})}
              {...(s.accent ? { accent: s.accent } : {})}
              {...(s.tag ? { trailing: s.tag } : {})}
            />
            {s.summary && (
              <p className="min-w-0 break-words px-1 text-xs text-muted-foreground">{s.summary}</p>
            )}
            {(s.rows.length > 0 || s.note) && (
              <div
                className={cn(
                  "flex flex-col",
                  s.tone === "attention" ? "gap-2" : "divide-y divide-border/60",
                )}
              >
                {s.rows.length > 0 ? (
                  s.rows.map((r) => <div key={r.key}>{r.node}</div>)
                ) : (
                  <p className="px-2 py-2 text-xs text-muted-foreground">{s.note}</p>
                )}
              </div>
            )}
          </section>
        ))
      )}
    </section>
  );
}
