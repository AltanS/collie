import { useEffect, useRef, useState } from "react";
import { Download, Loader2, Sigma, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { OneOf } from "@/components/ui/one-of";
import { Progress } from "@/components/ui/progress";
import { Select } from "@/components/ui/select";
import { apiErrorStatus, removeMathPack, startMathPack } from "@/lib/api";
import { MATH_ENGINES, isMathEngine, mathEngineOf, setDesignMath, useDesignPrefs, type MathEngine } from "@/lib/design";
import { loadMathEngine } from "@/lib/math/engine";
import {
  MATH_PACK_APPROX_BYTES,
  mathEnginesServed,
  noteMathPack,
  refreshMathPack,
  setWantedMathEngine,
  useMathPack,
  type MathPackView,
} from "@/lib/math-pack";
import { formatDownloadSize } from "@/lib/machine-units";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { isReadOnly, type MathPackStatus } from "@/lib/types";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";

// The Math card — which engine typesets LaTeX in Markdown, per device. Off is the default, and Off
// is exactly the app before math existed: `$` is a dollar and no engine is downloaded.
//
// Laid out like the Typeface card: a set-once preference in a native select (`ui/select.tsx`), and
// a note under it. The three notes share one cell (`ui/one-of.tsx`), so the card is as tall as the
// longest note in this locale and choosing never changes its height (DESIGN.md §2).
//
// THE ENGINES ARE A DOWNLOAD ON THE HOST (ADR 0132, lib/math-pack.ts). While the host has no pack,
// the select shows Off, and choosing KaTeX or MathJax is the tap that downloads it: the progress shows
// under the select, and on ready the engine that was chosen becomes the choice. The button under the
// select downloads the pack without choosing. One pack holds both engines. A device that may not write,
// a build with no pack and a download in flight leave the two engines disabled, with one line saying
// why. A ready pack the host downloaded can be removed; the engines a source build carries cannot,
// because the bridge never writes under `web/dist`.
//
// A REFUSED POST OR DELETE is said in the card, as one line keyed on what kind of answer it was
// (refused, the host failed, no answer), never the body or a transport message. A 409 says nothing
// here: the host's status then says "nothing to offer" itself. The line belongs to the answer it
// was written for, so the next answer (the poll finding the download running after all) hides it.
//
// A STORED ENGINE WITH NO PACK ON THE HOST (an update left the pack behind) shows as Off, and comes
// back by itself once the pack is downloaded again: it is the person's own earlier choice, and the
// update did not ask them to make it twice (review 2, item 8).
//
// ENGINE NAMES ARE PROPER NOUNS and are not translated; "Off" and the notes are phrases and go
// through the dictionary.

type Engine = Exclude<MathEngine, "off">;

const ENGINE_LABELS = { katex: "KaTeX", mathjax: "MathJax" } satisfies Record<Engine, string>;

const NOTE_KEYS = {
  off: "settings.math.note.off",
  katex: "settings.math.note.katex",
  mathjax: "settings.math.note.mathjax",
} as const satisfies Record<MathEngine, `settings.math.note.${string}`>;

const ERROR_KEYS = {
  "download-failed": "settings.appearance.math.error.downloadFailed",
  "low-space": "settings.appearance.math.error.lowSpace",
  "hash-mismatch": "settings.appearance.math.error.hashMismatch",
  "bad-pack": "settings.appearance.math.error.badPack",
} as const satisfies Record<NonNullable<Extract<MathPackStatus, { state: "absent" }>["error"]>, MessageKey>;

/** What a refused POST or DELETE says, by its HTTP status; `undefined` is no answer at all. */
function refusalKey(status: number | undefined): MessageKey | null {
  if (status === 409) return null;
  if (status === undefined) return "settings.appearance.math.refused.offline";
  return status >= 500 ? "settings.appearance.math.refused.server" : "settings.appearance.math.refused.denied";
}

const UNAVAILABLE_KEYS = {
  "dev-build": "settings.appearance.math.unavailable.devBuild",
  "no-pack": "settings.appearance.math.unavailable.noPack",
} as const satisfies Record<Extract<MathPackStatus, { state: "unavailable" }>["reason"], MessageKey>;

/** Settings card: the math engine. Device-local, like the typeface; the pack it needs is the host's. */
export function MathControl() {
  useLocale();
  const engine = mathEngineOf(useDesignPrefs());
  const pack = useMathPack();
  const root = useOptionalRootData();
  const { refused } = usePairing();
  const canWrite = !isReadOnly(root?.device) && !refused;
  const [busy, setBusy] = useState(false);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  // A refused POST or DELETE, said in the card where the person tapped (lib/ack-manifest.ts), for as
  // long as the answer it was written against is the one on screen.
  const [failure, setFailure] = useState<{ key: MessageKey; on: MathPackView } | null>(null);

  const served = mathEnginesServed(pack);
  const shown: MathEngine = served ? engine : "off";
  const canDownload = canWrite && pack?.state === "absent";
  const enginesOpen = served || canDownload;

  async function download(next: Engine | null): Promise<void> {
    // Held by lib/math-pack.ts, not here: leaving Settings mid-download keeps the choice.
    setWantedMathEngine(next);
    setBusy(true);
    setFailure(null);
    try {
      noteMathPack(await startMathPack());
    } catch (error) {
      const key = refusalKey(apiErrorStatus(error));
      const after = await refreshMathPack();
      // A POST that timed out while the host did start: the progress says it, not a red line.
      const moved = after?.state === "downloading" || after?.state === "ready" || after?.state === "unavailable";
      if (!moved) setWantedMathEngine(null);
      if (key !== null && !moved) setFailure({ key, on: after });
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    setFailure(null);
    try {
      noteMathPack(await removeMathPack());
      setDesignMath("off");
    } catch (error) {
      const key = refusalKey(apiErrorStatus(error));
      const after = await refreshMathPack();
      if (key !== null && after?.state === "ready") setFailure({ key, on: after });
    } finally {
      setBusy(false);
      setConfirmingRemove(false);
    }
  }

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Sigma className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("settings.math.title")}</div>
            <p className="text-sm text-muted-foreground">{t("settings.math.description")}</p>
          </div>
        </div>
      </div>

      <div data-slot="list-group" className="border-t border-border">
        <div className="flex items-center justify-between gap-4 px-4 py-3">
          <label htmlFor="pref-math" className="text-sm font-medium">
            {t("settings.math.engine")}
          </label>
          <Select
            id="pref-math"
            className="shrink-0"
            value={shown}
            // A DOM value is a plain string, so it is parsed back here rather than asserted. The
            // engine starts loading on the change, so Chat finds it ready. With no pack on the host,
            // choosing an engine is the tap that downloads it.
            onChange={(event) => {
              const next = event.target.value;
              if (!isMathEngine(next)) return;
              if (next === "off") {
                setWantedMathEngine(null);
                setDesignMath("off");
                return;
              }
              if (served) {
                setDesignMath(next);
                void loadMathEngine(next);
                return;
              }
              if (canDownload && !busy) void download(next);
            }}
          >
            {MATH_ENGINES.map((choice) => (
              <option key={choice} value={choice} disabled={choice !== "off" && !enginesOpen}>
                {choice === "off" ? t("settings.math.off") : ENGINE_LABELS[choice]}
              </option>
            ))}
          </Select>
        </div>
        <OneOf
          className="px-4 py-2.5"
          active={shown}
          options={MATH_ENGINES.map((choice) => ({
            key: choice,
            node: <p className="text-xs text-muted-foreground">{t(NOTE_KEYS[choice])}</p>,
          }))}
        />
        <PackRow
          pack={pack}
          canWrite={canWrite}
          busy={busy}
          confirmingRemove={confirmingRemove}
          onDownload={() => void download(null)}
          onAskRemove={() => setConfirmingRemove(true)}
          onCancelRemove={() => setConfirmingRemove(false)}
          onRemove={() => void remove()}
        />
        {failure !== null && failure.on === pack && (
          <p role="status" className="px-4 py-3 text-xs text-status-blocked">
            {t(failure.key)}
          </p>
        )}
      </div>
    </Card>
  );
}

interface PackRowProps {
  pack: MathPackView;
  canWrite: boolean;
  busy: boolean;
  confirmingRemove: boolean;
  onDownload: () => void;
  onAskRemove: () => void;
  onCancelRemove: () => void;
  onRemove: () => void;
}

/** One muted line under the select. */
function Line({ text }: { text: MessageKey }) {
  return <p className="text-xs text-muted-foreground">{t(text)}</p>;
}

/** What the host's pack asks of this card, under the select. Nothing for an older bridge. */
function PackRow(props: PackRowProps) {
  const { pack, canWrite, busy, confirmingRemove } = props;
  const cancel = useRef<HTMLButtonElement>(null);
  // The confirm replaces the button that had the focus: the focus moves to Cancel, the safe answer.
  useEffect(() => {
    if (confirmingRemove) cancel.current?.focus();
  }, [confirmingRemove]);
  if (pack === null) return null;

  switch (pack.state) {
    case "absent":
      return (
        <div className="space-y-2 px-4 py-3">
          {canWrite ? (
            <>
              <Button className="h-auto min-h-11 w-full whitespace-normal py-2" disabled={busy} onClick={props.onDownload}>
                {busy ? <Loader2 className="size-4 animate-spin" /> : <Download className="size-4" />}
                {t("settings.appearance.math.download", {
                  // A no-break space, so a wrapped label never leaves the unit alone on a line.
                  size: formatDownloadSize(MATH_PACK_APPROX_BYTES).replace(" ", "\u00a0"),
                })}
              </Button>
              <Line text="settings.appearance.math.downloadNote" />
            </>
          ) : (
            <Line text="settings.appearance.math.readOnly" />
          )}
          {pack.error !== undefined && (
            <p role="status" className="text-xs text-status-blocked">
              {t(ERROR_KEYS[pack.error])}
            </p>
          )}
        </div>
      );
    case "downloading": {
      const total = pack.total;
      return (
        <div className="space-y-1.5 px-4 py-3">
          <Line text="settings.appearance.math.downloading" />
          <Progress
            value={total !== null && total > 0 ? (pack.received / total) * 100 : null}
            label={t("settings.appearance.math.progressAria")}
          />
          {total !== null && (
            <p className="text-xs tabular-nums text-muted-foreground">
              {t("settings.appearance.math.progress", {
                received: formatDownloadSize(pack.received),
                total: formatDownloadSize(total),
              })}
            </p>
          )}
        </div>
      );
    }
    case "unreachable":
      return (
        <div className="px-4 py-3">
          <Line text="settings.appearance.math.unreachable" />
        </div>
      );
    case "unavailable":
      return <div className="px-4 py-3"><Line text={UNAVAILABLE_KEYS[pack.reason]} /></div>;
    case "ready":
      if (pack.source !== "store" || !canWrite) return null;
      return (
        <div className="space-y-2 px-4 py-3">
          {confirmingRemove ? (
            <>
              <p className="text-xs text-foreground">{t("settings.appearance.math.remove.confirm")}</p>
              <div className="flex gap-2">
                <Button ref={cancel} variant="ghost" className="h-11" disabled={busy} onClick={props.onCancelRemove}>
                  {t("settings.appearance.math.remove.cancel")}
                </Button>
                <Button variant="destructive" className="h-11" disabled={busy} onClick={props.onRemove}>
                  {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
                  {t("settings.appearance.math.remove.action")}
                </Button>
              </div>
            </>
          ) : (
            <>
              <Button variant="outline" className="h-11" onClick={props.onAskRemove}>
                {t("settings.appearance.math.remove")}
              </Button>
              <Line text="settings.appearance.math.removeNote" />
            </>
          )}
        </div>
      );
  }
}
