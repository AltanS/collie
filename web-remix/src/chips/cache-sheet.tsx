import type { Handle } from "remix/component";

import { fetchCacheRules } from "@web/lib/api";
import { timeAgoShort } from "@web/lib/format";
import { hostName } from "@web/lib/hosts";
import { t } from "@web/lib/i18n";
import type { CacheRuleWire, PaneCache } from "@web/lib/types";

import { snapshot } from "../lib/data";
import { useLocale } from "../lib/i18n-store";
import { scheduleUpdate } from "../lib/store";
import { BottomSheet } from "../ui/sheet";
import { crewOf } from "./crew";

// Port of web/src/components/cache-sheet.tsx (ADR 0041/0042): the rule behind a cache chip's number.
// The catalog (`GET /api/cache-rules`) is read lazily the first time a sheet opens and kept for the
// document: it only moves on a release or a `cache-rules.toml` edit. A peer's pane cites no rule from
// this machine's catalog; it says where the number was read instead.
let catalog: CacheRuleWire[] | null = null;
let loading: Promise<void> | null = null;

function loadCatalog(): Promise<void> {
  loading ??= fetchCacheRules()
    .then((body) => {
      catalog = body.rules;
      return undefined;
    })
    .catch(() => {
      loading = null; // no catalog: the short form, and a later open may try again
    });
  return loading;
}

export interface CacheSheetProps {
  open: boolean;
  onClose: () => void;
  cache: PaneCache | undefined;
  host?: string | undefined;
}

function stateWord(state: PaneCache["state"]): string {
  if (state === "expiring") return t("cache.sheet.state.expiring");
  if (state === "cold") return t("cache.sheet.state.cold");
  return t("cache.sheet.state.warm");
}

function resetLine(cache: PaneCache): string | null {
  if (cache.state !== "cold" || cache.reset === undefined) return null;
  if (cache.coldReason === "reset") return t("cache.sheet.reset.pending", { action: cache.reset.label });
  if (cache.coldReason === "observed") return t("cache.sheet.reset.cause", { action: cache.reset.label });
  return null;
}

const minutes = (ttlSeconds: number): string => String(Math.max(1, Math.round(ttlSeconds / 60)));

export function CacheSheet(handle: Handle<CacheSheetProps>) {
  useLocale(handle);
  let asked = false;
  return () => {
    const { open, onClose, cache, host } = handle.props;
    if (open && catalog === null && !asked) {
      asked = true;
      handle.queueTask(() => {
        void loadCatalog().then(() => {
          if (!handle.signal.aborted) scheduleUpdate(handle);
          return undefined;
        });
      });
    }
    if (cache === undefined) return null;
    const crew = crewOf(snapshot.get().data);
    const onPeer = crew.multi && host !== undefined;
    const rule = onPeer ? undefined : catalog?.find((r) => r.id === cache.ruleId);
    const reset = resetLine(cache);
    return (
      <BottomSheet open={open} onClose={onClose} title={t("cache.sheet.title")}>
        <div data-testid="cache-sheet">
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 px-4 pb-4 text-sm">
            <dt class="text-muted-foreground">{t("cache.sheet.state")}</dt>
            <dd>{stateWord(cache.state)}</dd>
            <dt class="text-muted-foreground">{t("cache.sheet.ttl")}</dt>
            <dd class="tabular-nums">{t("cache.sheet.ttlMinutes", { minutes: minutes(cache.ttlSeconds) })}</dd>
            <dt class="text-muted-foreground">{t("cache.sheet.confidence")}</dt>
            <dd>
              {t(`cache.confidence.${cache.confidence}`)}
              {cache.confidence === "observed" && cache.measuredAt !== undefined ? (
                <span class="text-muted-foreground">
                  {" · "}
                  {t("cache.sheet.lastRead", { age: timeAgoShort(cache.measuredAt) })}
                </span>
              ) : null}
            </dd>
            <dt class="text-muted-foreground">{t("cache.sheet.rule")}</dt>
            <dd class="font-mono text-xs">{cache.ruleId === "" ? "—" : cache.ruleId}</dd>
            {rule !== undefined ? (
              <>
                <dt class="text-muted-foreground">{t("cache.sheet.source")}</dt>
                <dd class="min-w-0">
                  <a href={rule.sourceUrl} target="_blank" rel="noreferrer noopener" class="break-words underline underline-offset-2">
                    {rule.sourceTitle}
                  </a>
                </dd>
                <dt class="text-muted-foreground">{t("cache.sheet.retrieved")}</dt>
                <dd class="tabular-nums">{rule.retrievedAt}</dd>
              </>
            ) : null}
          </dl>
          {reset !== null ? <p class="px-4 pb-3 text-sm">{reset}</p> : null}
          {cache.overridden === true ? (
            <p class="px-4 pb-3 text-xs text-muted-foreground">
              {t("cache.sheet.overridden")}
              {rule?.overridden !== undefined ? ` · ${rule.overridden.retrieved}` : ""}
            </p>
          ) : null}
          {rule?.note !== undefined && !onPeer ? <p class="px-4 pb-3 text-xs text-muted-foreground">{rule.note}</p> : null}
          {onPeer ? (
            <p class="px-4 pb-3 text-xs text-muted-foreground">
              {t("cache.sheet.onPeer", { host: hostName(crew.servers, host) ?? host })}
            </p>
          ) : null}
        </div>
      </BottomSheet>
    );
  };
}
