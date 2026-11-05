import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { BarChart3, ChevronDown, Loader2 } from "lucide-react";
import { useLocation } from "react-router";

import { useCrew } from "@/components/crew-provider";
import { Card } from "@/components/ui/card";
import { Collapse } from "@/components/ui/collapse";
import { Switch } from "@/components/ui/switch";
import { useLocale } from "@/hooks/use-locale";
import { fetchTelemetry, setTelemetry } from "@/lib/api";
import { describeThrownError } from "@/lib/api-error-message";
import { t, type MessageKey } from "@/lib/i18n";
import { installCountPath, TELEMETRY_SETTINGS_HASH } from "@/lib/nav";
import { useScope } from "@/lib/session";
import { useNav } from "@/hooks/use-nav";
import { SettingsNavRow } from "@/components/settings-nav-row";
import type { TelemetryDecider, TelemetrySetting, TelemetryView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { mintRequestId } from "@/lib/worktree-name";

// ── ANONYMOUS INSTALL COUNT (M86 spec 02, ADR 0129) ──────────────────────────────────────────────
//
// Once a day this machine sends a random ID, the Collie version, the OS and the install kind. This
// card shows whether that is on, which switch decided it, and the exact message the next ping would
// carry. The bridge owns every fact: the card reads `GET /api/telemetry`, writes `POST /api/telemetry`
// and shows the state the machine answers with. It never guesses a state after a tap.
//
// ── THE SWITCH, AND WHEN IT CANNOT MOVE ──────────────────────────────────────
// Off is final when the machine itself said so: `DO_NOT_TRACK`, `COLLIE_TELEMETRY=0`, `telemetry =
// false` in the config file, CI, a rehearsal mirror, a development build or a bad COLLIE_TELEMETRY_URL. The phone cannot undo
// those, so the switch is off and disabled and the line under it names the cause. On is never final:
// a phone "off" beats every on word, so a count that is on by `COLLIE_TELEMETRY` or the config file
// still has a usable switch, and the line says where the "on" came from.
//
// ── THIS MACHINE ONLY ────────────────────────────────────────────────────────
// The switch is per machine. A crew member sends its own count and keeps its own switch, so a lead
// with members lists their names under it and says the switch does not cover them. The names come
// from the roster the Crew page reads (`useCrew`); there is no extra request.
//
// ── ONE LINE, ALWAYS THERE ───────────────────────────────────────────────────
// The cause line holds one sentence in every state (reading, failed, saving, each cause), so a state
// arriving grows nothing above it. The next message opens through `Collapse` (DESIGN.md §11).

/** The decided-by values the phone cannot override once the count is off. */
const LOCKED_OFF: ReadonlySet<TelemetryDecider> = new Set([
  "env",
  "config",
  "do_not_track",
  "ci",
  "mirror",
  "dev_build",
  "url",
]);

/** Where the security page explains what is sent. */
export const TELEMETRY_DOCS_URL = "https://colliepwa.dev/docs/security#what-leaves-your-machine";

/** Whether the phone's switch cannot move this state. */
export function isTelemetryLocked(view: Pick<TelemetryView, "on" | "decidedBy">): boolean {
  return !view.on && LOCKED_OFF.has(view.decidedBy);
}

/** The sentence that names the switch which decided, for the state as it stands. */
export function telemetryCauseKey(view: Pick<TelemetryView, "on" | "decidedBy">): MessageKey {
  switch (view.decidedBy) {
    case "do_not_track":
      return "telemetry.card.cause.doNotTrack";
    case "env":
      return view.on ? "telemetry.card.cause.env.on" : "telemetry.card.cause.env.off";
    case "config":
      return view.on ? "telemetry.card.cause.config.on" : "telemetry.card.cause.config.off";
    case "ci":
      return "telemetry.card.cause.ci";
    case "mirror":
      return "telemetry.card.cause.mirror";
    case "dev_build":
      return "telemetry.card.cause.devBuild";
    case "url":
      return "telemetry.card.cause.url";
    case "settings":
      return view.on ? "telemetry.card.cause.settings.on" : "telemetry.card.cause.settings.off";
    case "default":
      return "telemetry.card.cause.default";
  }
}

type Load = { kind: "reading" } | { kind: "failed" } | { kind: "ready"; view: TelemetryView };

/** The machine's state, read once on mount. The card keeps the setter: a receipt replaces the reading. */
function useTelemetryLoad(): [Load, Dispatch<SetStateAction<Load>>] {
  const [load, setLoad] = useState<Load>({ kind: "reading" });
  useEffect(() => {
    const ac = new AbortController();
    void (async () => {
      try {
        const view = await fetchTelemetry(ac.signal);
        setLoad({ kind: "ready", view });
      } catch {
        if (ac.signal.aborted) return;
        setLoad({ kind: "failed" });
      }
    })();
    return () => ac.abort();
  }, []);
  return [load, setLoad];
}

/**
 * The row Settings → System keeps for the install count: the state in two or three words and a
 * chevron to the page that holds the switch and its explanation. It reads the same endpoint the card
 * does and never writes; the switch is on the page below.
 */
export function TelemetrySettingsRow() {
  useLocale();
  const nav = useNav();
  const scope = useScope();
  const [load] = useTelemetryLoad();
  const caption =
    load.kind === "reading"
      ? t("telemetry.row.reading")
      : load.kind === "failed"
        ? t("telemetry.row.failed")
        : t(load.view.on ? "telemetry.row.on" : "telemetry.row.off");
  return (
    <Card className="gap-0 py-0" data-slot="telemetry-row">
      <SettingsNavRow icon={BarChart3} title={t("telemetry.card.title")} caption={caption} onOpen={() => nav.down(installCountPath(scope))} />
    </Card>
  );
}

export function TelemetrySettingsCard() {
  useLocale();
  // The roster the Crew page already has. The switch is this machine's: a member keeps its own.
  const { servers } = useCrew();
  const members = servers.filter((server) => !server.isLead).map((server) => server.name);
  const [load, setLoad] = useTelemetryLoad();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nextOpen, setNextOpen] = useState(false);
  // The id of the tap in flight or last refused, until a receipt answers it. A retry of the SAME
  // setting reuses it, so a dropped answer is replayed by the bridge and never applied twice.
  const pending = useRef<{ setting: TelemetrySetting; requestId: string } | null>(null);
  const nextId = useId();
  const causeId = useId();

  // The card answers to its own fragment, like Paired devices: the dashboard notice's button lands here.
  const cardRef = useRef<HTMLDivElement>(null);
  const { hash } = useLocation();
  useEffect(() => {
    if (hash !== `#${TELEMETRY_SETTINGS_HASH}`) return;
    const card = cardRef.current;
    if (!card) return;
    card.scrollIntoView({ block: "start", behavior: "smooth" });
    card.focus({ preventScroll: true });
  }, [hash]);

  const view = load.kind === "ready" ? load.view : null;
  const locked = view !== null && isTelemetryLocked(view);

  async function choose(setting: TelemetrySetting): Promise<void> {
    const held = pending.current;
    const requestId = held?.setting === setting ? held.requestId : mintRequestId();
    pending.current = { setting, requestId };
    setSaving(true);
    setError(null);
    try {
      const answer = await setTelemetry({ setting, requestId });
      pending.current = null;
      setLoad({ kind: "ready", view: { on: answer.on, decidedBy: answer.decidedBy, setting: answer.setting, next: answer.next } });
    } catch (thrown) {
      setError(t("telemetry.card.failed", { reason: describeThrownError(thrown) }));
    } finally {
      setSaving(false);
    }
  }

  const cause =
    load.kind === "reading"
      ? t("telemetry.card.reading")
      : load.kind === "failed"
        ? t("telemetry.card.readFailed")
        : t(telemetryCauseKey(load.view));

  return (
    <Card id={TELEMETRY_SETTINGS_HASH} ref={cardRef} tabIndex={-1} className="gap-0 py-0 outline-none" data-slot="telemetry-card">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <BarChart3 className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("telemetry.card.title")}</div>
            <p className="text-sm text-muted-foreground">{t("telemetry.card.description")}</p>
          </div>
        </div>
        <div className="flex h-6 w-11 shrink-0 items-center justify-center">
          <Switch
            checked={view?.on ?? false}
            onCheckedChange={(on) => void choose(on ? "on" : "off")}
            disabled={view === null || saving || locked}
            aria-label={t("telemetry.card.title")}
            aria-describedby={causeId}
          />
        </div>
      </div>

      {/* Always rendered, so a reading, a receipt or a refusal arriving grows nothing above it. */}
      <div className="flex flex-col gap-2 border-t border-border px-4 py-3">
        <p id={causeId} role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
          {saving && <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden="true" />}
          {saving ? t("telemetry.card.saving") : error !== null ? "" : cause}
        </p>
        {error !== null && <p className="text-sm text-status-blocked">{error}</p>}
        {/* Fixed text, there from the first paint: nothing above it moves when the reading arrives. */}
        <p className="text-sm text-muted-foreground">{t("telemetry.card.thisMachine")}</p>
        {members.length > 0 && (
          <p data-slot="telemetry-members" className="text-sm text-muted-foreground">
            {t("telemetry.card.members", { names: members.join(", ") })}
          </p>
        )}
      </div>

      {view !== null && (
        <div className="border-t border-border">
          <button
            type="button"
            aria-expanded={nextOpen}
            aria-controls={nextId}
            onClick={() => setNextOpen((open) => !open)}
            className="flex min-h-11 w-full items-center justify-between gap-3 px-4 text-left text-sm active:bg-muted/60"
          >
            <span>{nextOpen ? t("telemetry.card.next.hide") : t("telemetry.card.next.show")}</span>
            <ChevronDown aria-hidden="true" className={cn("size-4 shrink-0 text-muted-foreground transition-transform", nextOpen && "rotate-180")} />
          </button>
          <Collapse open={nextOpen}>
            <div id={nextId} className="px-4 pb-3">
              {view.next === null ? (
                <p className="text-sm text-muted-foreground">{t("telemetry.card.next.none")}</p>
              ) : (
                <pre
                  aria-label={t("telemetry.card.next.aria")}
                  data-slot="telemetry-next"
                  className="rounded-sm border border-border bg-muted/40 p-3 font-mono text-xs leading-relaxed break-words whitespace-pre-wrap"
                >
                  {JSON.stringify(view.next, null, 2)}
                </pre>
              )}
            </div>
          </Collapse>
        </div>
      )}

      <div className="border-t border-border px-4 py-3 text-sm">
        <a
          href={TELEMETRY_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="break-words underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t("telemetry.card.more")}
        </a>
      </div>
    </Card>
  );
}
