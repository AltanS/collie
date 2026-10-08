import type { ReactNode } from "react";
import { ArrowLeft, CircleOff, CloudOff, GitPullRequest, Loader2, RefreshCw, TriangleAlert, type LucideIcon } from "lucide-react";

import { RouteHeader } from "@/components/app-header";
import { GithubWorkLists } from "@/components/github-work-lists";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import { BandMain } from "@/components/ui/strip-host";
import { useGithubWork, type GithubWorkState } from "@/hooks/use-github-work";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useTick } from "@/hooks/use-tick";
import type { GithubWorkAnswer } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { t } from "@/lib/i18n";
import { homePath } from "@/lib/nav";
import { scopeKey, useScope, type Scope } from "@/lib/session";
import { cn } from "@/lib/utils";

// GitHub work (ADR 0091): for the scoped machine's `gh` user, my open pull requests (what is stuck,
// and why), the ones waiting on my review, and the issues assigned to me. READ-ONLY: every row opens
// GitHub in a new tab, and nothing on this screen acts on GitHub.
//
// ── IT FETCHES FOR ITSELF, OFF THE POLL LOOP ─────────────────────────────────
// No route loader: a loader re-runs on every root poll tick, and this read can wait seconds on the
// host's `gh`. hooks/use-github-work.ts reads on open, every 60 s while visible, and on the refresh
// button with `fresh`. The bridge holds the answer for 60 s and never asks GitHub on a timer of its
// own, so this screen being open is the only thing that makes it ask.
//
// ── EVERY STATE IS A SENTENCE, NEVER A BLANK LIST ────────────────────────────
// Off, not available on that machine, gh missing or signed out, a timeout, an error, and "could not
// reach the machine" are each their own card, with the one thing to do about it. A list that is
// stale, or whose last refresh failed, stays on screen under a notice saying so.

/**
 * `given` hands the answer in and switches the live read off: the playground has no bridge to ask.
 * The router never passes it.
 */
export function GithubRoute({ given }: { given?: GithubWorkState }): ReactNode {
  const scope = useScope();
  // Keyed by scope, so another machine starts from nothing rather than showing this machine's lists
  // under the next one's name while its own answer is on its way.
  return <GithubScreen key={scopeKey(scope)} scope={scope} given={given} />;
}

function GithubScreen({ scope, given }: { scope: Scope; given: GithubWorkState | undefined }) {
  const nav = useNav();
  useLocale();
  const live = useGithubWork(scope, given === undefined);
  const { answer, failed } = given ?? live;
  // The ages on screen (the header's "updated 3m ago" and every row's) move with the phone's own
  // clock, once a minute, which is their resolution.
  const now = useTick(true, 60_000);
  const machine = machineOf(answer, scope);
  const ok = answer?.state === "ok" ? answer : null;

  return (
    <div className="mx-auto flex min-h-0 w-full max-w-screen-sm flex-1 flex-col">
      <RouteHeader
        width="column"
        override={
          <>
            <Button
              variant="ghost"
              size="icon"
              // 44px, the tap floor every control in this row shares. size="icon" alone is 36px.
              className="size-11 shrink-0"
              onClick={() => nav.up(homePath(scope))}
              aria-label={t("github.nav.back")}
            >
              <ArrowLeft className="size-5" />
            </Button>
            <div className="min-w-0 flex-1">
              <h1 className="truncate text-lg font-semibold leading-tight tracking-tight">{t("github.title")}</h1>
              {/* Always drawn and always one line tall, so the title never moves when the answer
                  lands and the line fills in. */}
              <p className="h-[0.9375rem] truncate text-xs leading-tight text-muted-foreground">
                {ok !== null
                  ? t("github.subtitle", { login: ok.login, machine, age: timeAgo(Date.parse(ok.fetchedAt), now) })
                  : machine}
              </p>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="size-11 shrink-0"
              onClick={live.refresh}
              aria-label={t("github.refreshAria")}
              disabled={live.refreshing || given !== undefined}
            >
              {/* The icon spins in its own box: the button keeps its size whether or not a refresh is
                  in flight. */}
              <RefreshCw className={cn("size-5", live.refreshing && "animate-spin")} />
            </Button>
          </>
        }
      />

      <BandMain base={16} className="relative flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <Collapse open={staleNote(answer, failed) !== null}>
          {staleNote(answer, failed) !== null && (
            <Notice tone="caution" variant="box" announce="status" icon={<TriangleAlert className="size-4" />}>
              <StaleCopy answer={answer} failed={failed} machine={machine} now={now} />
            </Notice>
          )}
        </Collapse>
        <Body answer={answer} failed={failed} machine={machine} now={now} />
      </BandMain>
    </div>
  );
}

/**
 * The machine's name as the answer gives it, or, before there is one, the scope's host, or "this
 * machine" for the one the phone is connected to.
 */
function machineOf(answer: GithubWorkAnswer | null, scope: Scope): string {
  if (answer !== null && answer.state !== "absent") return answer.machine;
  return scope.host ?? t("github.thisMachine");
}

/** Why the lists on screen may not be current, or `null` when they are as good as the bridge has. */
function staleNote(answer: GithubWorkAnswer | null, failed: boolean): "unreachable" | "refresh-failed" | null {
  if (answer === null) return null;
  if (failed) return "unreachable";
  if (answer.state === "ok" && answer.error !== undefined) return "refresh-failed";
  return null;
}

function StaleCopy({
  answer,
  failed,
  machine,
  now,
}: {
  answer: GithubWorkAnswer | null;
  failed: boolean;
  machine: string;
  now: number;
}) {
  const note = staleNote(answer, failed);
  if (note === "unreachable") return <span>{t("github.stale.unreachable", { machine })}</span>;
  if (answer?.state !== "ok") return null;
  return (
    <span className="flex min-w-0 flex-col gap-1">
      <span>{t("github.stale.refreshFailed", { age: timeAgo(Date.parse(answer.fetchedAt), now) })}</span>
      {answer.error !== undefined && answer.error !== "" && (
        <span className="break-words font-mono text-[11px] font-normal">{answer.error}</span>
      )}
    </span>
  );
}

function Body({
  answer,
  failed,
  machine,
  now,
}: {
  answer: GithubWorkAnswer | null;
  failed: boolean;
  machine: string;
  now: number;
}) {
  if (answer === null) {
    return failed ? (
      <StateCard
        icon={CloudOff}
        title={t("github.unreachable.title", { machine })}
        description={t("github.unreachable.description")}
      />
    ) : (
      <LoadingCard machine={machine} />
    );
  }
  switch (answer.state) {
    case "absent":
      return (
        <StateCard
          icon={CircleOff}
          title={t("github.absent.title", { machine })}
          description={t("github.absent.description")}
        />
      );
    case "off":
      return (
        <StateCard
          icon={GitPullRequest}
          title={t("github.off.title", { machine })}
          description={t("github.off.description")}
          code="COLLIE_GITHUB=1"
        />
      );
    // `cold` is only ever the answer to a peek; this screen never peeks, but a bridge that says it
    // is reading is answered the same way: the read is on its way.
    case "cold":
      return <LoadingCard machine={machine} />;
    case "unavailable":
      return <UnavailableCard answer={answer} machine={machine} />;
    case "ok":
      return <GithubWorkLists work={answer} now={now} />;
  }
}

/** The first read can take several seconds: the bridge is asking GitHub through the host's `gh`. */
function LoadingCard({ machine }: { machine: string }) {
  return (
    <StateCard
      icon={Loader2}
      spin
      title={t("github.loading.title")}
      description={t("github.loading.description", { machine })}
    />
  );
}

/** `gh` could not answer. Each reason names its own remedy; what `gh` said is shown verbatim under it. */
function UnavailableCard({
  answer,
  machine,
}: {
  answer: Extract<GithubWorkAnswer, { state: "unavailable" }>;
  machine: string;
}) {
  const detail = answer.message === "" ? undefined : answer.message;
  switch (answer.reason) {
    case "gh-missing":
      return (
        <StateCard
          icon={TriangleAlert}
          title={t("github.unavailable.ghMissing.title", { machine })}
          description={t("github.unavailable.ghMissing.description")}
          detail={detail}
        />
      );
    case "gh-unauthenticated":
      return (
        <StateCard
          icon={TriangleAlert}
          title={t("github.unavailable.ghUnauthenticated.title", { machine })}
          description={t("github.unavailable.ghUnauthenticated.description")}
          code="gh auth login"
          detail={detail}
        />
      );
    case "timeout":
      return (
        <StateCard
          icon={TriangleAlert}
          title={t("github.unavailable.timeout.title")}
          description={t("github.unavailable.timeout.description", { machine })}
          detail={detail}
        />
      );
    case "error":
      return (
        <StateCard
          icon={TriangleAlert}
          title={t("github.unavailable.error.title", { machine })}
          description={t("github.unavailable.error.description")}
          detail={detail}
        />
      );
  }
}

/**
 * The one card this screen shows when it has no lists to show: crew's empty-card shape, plus the
 * command to run (`code`) and what the machine said (`detail`), both verbatim in mono, since the
 * operator types the first and may search for the second.
 */
function StateCard({
  icon: Icon,
  spin = false,
  title,
  description,
  code,
  detail,
}: {
  icon: LucideIcon;
  spin?: boolean;
  title: string;
  description: string;
  code?: string;
  detail?: string;
}) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4">
        <Icon className={cn("mt-0.5 size-5 shrink-0 text-muted-foreground", spin && "animate-spin")} aria-hidden />
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="font-medium">{title}</div>
          <p className="text-sm text-muted-foreground">{description}</p>
          {code !== undefined && (
            <code className="self-start rounded-sm border border-border px-2 py-1 font-mono text-xs">{code}</code>
          )}
          {detail !== undefined && (
            <p className="break-words font-mono text-[11px] text-muted-foreground">{detail}</p>
          )}
        </div>
      </div>
    </Card>
  );
}
