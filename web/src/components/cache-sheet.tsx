import { useEffect, useState } from "react";

import { useCrew } from "@/components/crew-provider";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { fetchCacheRules } from "@/lib/api";
import { timeAgoShort } from "@/lib/format";
import { hostName } from "@/lib/hosts";
import { t } from "@/lib/i18n";
import type { CacheRuleWire, PaneCache } from "@/lib/types";

// Where the number came from. A READING, not a setting: there is no control in this sheet, and the
// only lever the feature has is `cache-rules.toml` on the machine that computed it.
//
// ── THE CATALOG IS FETCHED, NOT CARRIED ──────────────────────────────────────
// A pane carries seven small fields; the rule's label, its source title and the date it was read live
// in `GET /api/cache-rules`, asked for once per boot the first time a sheet opens. Forty panes on a
// dashboard therefore do not each carry a vendor url.
//
// ── A RESET NAMES ITS ACTION, IN ONE LINE ────────────────────────────────────
// A `/model` switch turns the chip cold with time still on the clock, which is the one cold a reader
// would doubt. So when the bridge names the action behind a cold reading, the sheet says it: the
// rule's own label in a translated sentence. The label rides the wire, so a peer's pane gets the same
// line with no catalog behind it.
//
// ── ON A PEER'S PANE THE SHEET IS SHORTER, AND SAYS SO ───────────────────────
// The state, the TTL, the confidence and the rule id all ride the wire, so they are shown. The SOURCE
// is not: the peer may hold its own override, and quoting the lead's catalog for the peer's number
// would cite a page that machine never read. So one sentence replaces those rows rather than a
// plausible-looking citation (ADR 0041, Decision 11).

interface CacheSheetProps {
  open: boolean;
  onClose: () => void;
  cache: PaneCache | undefined;
  /** The machine this pane lives on. Undefined = this one, which is every solo install. */
  host?: string | undefined;
}

/** The catalog, once per document. A module singleton because the answer is the same for every sheet. */
let catalog: CacheRuleWire[] | null = null;

/** Forget the catalog. For a test that states what a boot with no answer looks like; never app code. */
export function resetCacheCatalogForTests(): void {
  catalog = null;
}

export function CacheSheet({ open, onClose, cache, host }: CacheSheetProps) {
  useLocale();
  const { servers, multi } = useCrew();
  const [rules, setRules] = useState<CacheRuleWire[] | null>(catalog);

  useEffect(() => {
    // Lazily, and only once: nothing fetches until a reader has actually asked to see a source, and a
    // second open reads the module cache. A failure leaves `rules` null, which renders the short form —
    // the same shape a peer's pane gets, for the same honest reason: no catalog, no citation.
    if (!open || rules !== null) return;
    let live = true;
    const load = async () => {
      try {
        const body = await fetchCacheRules();
        catalog = body.rules;
        if (live) setRules(body.rules);
      } catch {
        /* no catalog: the short form, rather than a guessed citation */
      }
    };
    void load();
    return () => {
      live = false;
    };
  }, [open, rules]);

  if (cache === undefined) return null;
  const onPeer = multi && host !== undefined;
  const rule = onPeer ? undefined : rules?.find((r) => r.id === cache.ruleId);
  const measured = cache.confidence === "observed";
  const reset = resetLine(cache);

  return (
    <BottomSheet open={open} onClose={onClose} title={t("cache.sheet.title")}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 pb-4 text-sm">
        <dt className="text-muted-foreground">{t("cache.sheet.state")}</dt>
        <dd>{stateWord(cache.state)}</dd>
        <dt className="text-muted-foreground">{t("cache.sheet.ttl")}</dt>
        <dd className="tabular-nums">{t("cache.sheet.ttlMinutes", { minutes: minutes(cache.ttlSeconds) })}</dd>
        <dt className="text-muted-foreground">{t("cache.sheet.confidence")}</dt>
        <dd>
          {t(`cache.confidence.${cache.confidence}`)}
          {measured && cache.measuredAt !== undefined && (
            <span className="text-muted-foreground">
              {" · "}
              {t("cache.sheet.lastRead", { age: timeAgoShort(cache.measuredAt) })}
            </span>
          )}
        </dd>
        <dt className="text-muted-foreground">{t("cache.sheet.rule")}</dt>
        {/* The rule id and the vendor's own label are not translated: a rule id is a config key an
            operator types, and a label is another vendor's words about their own product. */}
        <dd className="font-mono text-xs">{cache.ruleId === "" ? "—" : cache.ruleId}</dd>
        {rule !== undefined && (
          <>
            <dt className="text-muted-foreground">{t("cache.sheet.source")}</dt>
            <dd className="min-w-0">
              <a
                href={rule.sourceUrl}
                target="_blank"
                rel="noreferrer noopener"
                className="break-words underline underline-offset-2"
              >
                {rule.sourceTitle}
              </a>
            </dd>
            <dt className="text-muted-foreground">{t("cache.sheet.retrieved")}</dt>
            <dd className="tabular-nums">{rule.retrievedAt}</dd>
          </>
        )}
      </dl>
      {reset !== null && <p className="px-4 pb-3 text-sm">{reset}</p>}
      {cache.overridden === true && (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          {t("cache.sheet.overridden")}
          {rule?.overridden !== undefined && ` · ${rule.overridden.retrieved}`}
        </p>
      )}
      {rule?.note !== undefined && !onPeer && (
        <p className="px-4 pb-3 text-xs text-muted-foreground">{rule.note}</p>
      )}
      {onPeer && (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          {t("cache.sheet.onPeer", { host: hostName(servers, host) ?? host })}
        </p>
      )}
    </BottomSheet>
  );
}

/** The line naming the action behind a cold reading, or null when the bridge named none. */
function resetLine(cache: PaneCache): string | null {
  if (cache.state !== "cold" || cache.reset === undefined) return null;
  if (cache.coldReason === "reset") return t("cache.sheet.reset.pending", { action: cache.reset.label });
  if (cache.coldReason === "observed") return t("cache.sheet.reset.cause", { action: cache.reset.label });
  return null;
}

function stateWord(state: PaneCache["state"]): string {
  if (state === "expiring") return t("cache.sheet.state.expiring");
  if (state === "cold") return t("cache.sheet.state.cold");
  return t("cache.sheet.state.warm");
}

/** The TTL in whole minutes, rounded up so a 180 s window does not read as 3 when it is exactly 3. */
function minutes(ttlSeconds: number): string {
  return String(Math.max(1, Math.round(ttlSeconds / 60)));
}
