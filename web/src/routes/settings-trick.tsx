import { Navigate, useParams } from "react-router";

import { SettingsPage } from "@/components/settings-page";
import { OfficialTrickDetail, TrickDetail } from "@/components/trick-detail";
import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { useLocale } from "@/hooks/use-locale";
import { useNav } from "@/hooks/use-nav";
import { useOfficialList, useTrickWrites, type TrickWriteCalls } from "@/hooks/use-trick-writes";
import { apiErrorFields, apiErrorStatus, fetchTrickCodeFile, fetchTrickCodeIndex, removeTrick } from "@/lib/api";
import { t } from "@/lib/i18n";
import { readTrickDetailKey, settingsSectionPath, type TrickDetailAddress } from "@/lib/nav";
import { usePairing } from "@/lib/pairing";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";
import { TrickBoundary } from "@/lib/tricks/boundary";
import { trickListRows, type TrickListRow } from "@/lib/tricks/list-order";
import type { OfficialTricksReply } from "@/lib/tricks/schema";
import { tricksStore, useTricksState, type TricksStore } from "@/lib/tricks/store";
import { setStatus } from "@/lib/status";
import { isReadOnly } from "@/lib/types";

// SETTINGS → TRICKS → ONE TRICK (2026-11-21): a trick's details on a page of its own, one level below the list, in
// place of the bottom sheet the list opened before ("it's a lot of info and deserving of an own page", Altan). The
// page draws components/trick-detail.tsx; the writes are the list's own (hooks/use-trick-writes.ts).
//
// THE ADDRESS is `settings/tricks/<key>` (lib/nav.ts `trickDetailPath`): `<host>:<id>` for a trick on a machine,
// the bare `<id>` for an entry of this machine's official list. An official id resolves to the added trick once
// it is added, so the page of an entry that was just added becomes the trick's own details, in place. A reload
// works: the page reads the tricks store and the official list, as the list does. While the first tricks reply has
// not come the page draws nothing; a key that names no trick says so calmly, with a way back to the list.
//
// The header's title is "Trick details"; the trick's name is the page's `h1`, in the head (2026-11-21).
// Back goes up one level (ADR 0067): to the list, or to the trick's own page when its header opened this one.
// Tricks switched off as a whole send a deep link to Settings, Tricks and the Hill, as the list does.

export interface SettingsTrickRouteProps extends TrickWriteCalls {
  /** The store the trick is read from. The app's own by default; a test passes its own. */
  store?: TricksStore;
  /** The official list read. The real route by default. */
  onOfficialList?: (signal?: AbortSignal) => Promise<OfficialTricksReply>;
  /** Draw the switches as one that may not write. Default: the device's own say. */
  readOnly?: boolean;
  /** The zone dates are written in. Tests pin it. */
  timeZone?: string;
  /** The remove write (ADR 0168). The real route by default; a test passes its own. */
  onRemove?: (host: string, id: string, rid: string) => Promise<{ rid: string; id: string }>;
}

/** The words a failed remove shows in its row: the bridge's three refusals in the phone's words, else one line. */
/** Whether no answer came to a remove: no HTTP status (a network error, a timeout), or the bridge's own failure (5xx). */
export function answerLost<TThrown>(thrown: TThrown): boolean {
  const status = apiErrorStatus(thrown);
  return status === undefined || status >= 500;
}

export function removeFailureLine<TThrown>(thrown: TThrown, name: string): string {
  const code = apiErrorFields(thrown)?.error;
  if (code === "on") return t("settings.tricks.remove.onLine");
  if (code === "running") return t("settings.tricks.remove.running");
  if (code === "link") return t("settings.tricks.remove.link");
  return t("settings.tricks.remove.failed", { name });
}

/** The list's row this page is about: the trick of `host:id`, or the official entry (added or not) of `id`. */
export function rowOfAddress(rows: readonly TrickListRow[], address: TrickDetailAddress): TrickListRow | undefined {
  if (address.kind === "trick") return rows.find((row) => row.kind === "trick" && row.trick.host === address.host && row.trick.id === address.id);
  return rows.find((row) => (row.kind === "official" ? row.entry.id === address.id : row.origin === "official" && row.entry?.id === address.id));
}

export function SettingsTrickRoute(props: SettingsTrickRouteProps) {
  const root = useOptionalRootData();
  const scope = useScope();
  if (root?.tricksOff === true) return <Navigate to={settingsSectionPath("tricks", scope)} replace />;
  return <TrickPage {...props} />;
}

function TrickPage({ store = tricksStore, onOfficialList, readOnly, timeZone, onRemove = removeTrick, ...calls }: SettingsTrickRouteProps) {
  useLocale();
  const { key = "" } = useParams<{ key: string }>();
  const scope = useScope();
  const nav = useNav();
  const root = useOptionalRootData();
  const { refused } = usePairing();
  const state = useTricksState(store);
  const official = useOfficialList(onOfficialList, state.tricks);
  const writes = useTrickWrites(calls, state.tricks, official);
  const list = settingsSectionPath("tricks", scope);
  const mayWrite = readOnly === undefined ? !isReadOnly(root?.device) && !refused : !readOnly;
  // Tricks switched off by the reply (the snapshot's own `tricksOff` redirects above): readable, nothing writes.
  const canWrite = mayWrite && state.off !== true;
  const address = readTrickDetailKey(key);
  const rows = trickListRows(state.tricks, official.list);
  const row = address === undefined ? undefined : rowOfAddress(rows, address);
  // Nothing true to say yet: the first tricks reply has not come, or an official id waits for the list's first answer.
  const waiting = state.rev === null || (row === undefined && address?.kind === "official" && !official.settled);
  const gone = !waiting && (row === undefined || state.gate === "windows");

  if (waiting || gone || row === undefined) {
    return (
      <SettingsPage title="tricks.session.details" parent={list}>
        {gone && (
          <div data-slot="trick-detail-gone" className="flex flex-col gap-3">
            <Notice tone="neutral" variant="box">
              {t("settings.tricks.detail.gone")}
            </Notice>
            <Button type="button" variant="outline" className="h-11 self-start" onClick={() => nav.up(list)}>
              {t("settings.tricks.detail.toList")}
            </Button>
          </div>
        )}
      </SettingsPage>
    );
  }

  if (row.kind === "official") {
    const entry = row.entry;
    return (
      <SettingsPage title="tricks.session.details" parent={list} headingBelow crumbs={[entry.name]}>
        <TrickBoundary fallback="none" resetKey={entry}>
          <OfficialTrickDetail entry={entry} busy={writes.adding.has(entry.id) || entry.state !== "absent"} canWrite={canWrite} onAdd={() => void writes.addOfficial(entry, "add")} timeZone={timeZone} />
        </TrickBoundary>
      </SettingsPage>
    );
  }

  const trick = row.trick;
  return (
    <SettingsPage title="tricks.session.details" parent={list} headingBelow crumbs={[trick.name]}>
      {/* Its own boundary: a page that throws draws nothing below the header, and the list stays a step back. */}
      <TrickBoundary fallback="none" resetKey={trick}>
        <TrickDetail
          trick={trick}
          runsOn={state.runsOn}
          origin={row.origin}
          checked={writes.checkedOf(trick)}
          onFlip={(on) => void writes.flip(trick, on)}
          auto={writes.autoOf(trick)}
          canWrite={canWrite}
          onAuto={(on) => void writes.flipAuto(trick, on)}
          onValue={async (field, value) => await writes.saveValue(trick, field, value)}
          readCode={{ index: () => fetchTrickCodeIndex(trick.host, trick.id), file: (file) => fetchTrickCodeFile(trick.host, trick.id, file) }}
          timeZone={timeZone}
          onRemove={async (rid) => {
            // The request id is the ask's (trick-remove-section.tsx): the bridge removes once for it, and a lost answer
            // sends it again, so the bridge answers what it did.
            try {
              await onRemove(trick.host, trick.id, rid);
            } catch (thrown) {
              return { line: removeFailureLine(thrown, trick.name), lost: answerLost(thrown) };
            }
            // Up to the list, so Back never returns to the page of a trick that is gone; the list says what happened.
            nav.up(list);
            setStatus(t("settings.tricks.remove.done", { name: trick.name }), "info");
            return null;
          }}
        />
      </TrickBoundary>
    </SettingsPage>
  );
}
