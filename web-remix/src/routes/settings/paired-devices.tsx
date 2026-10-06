// The paired-devices card: who is paired, revoke, and the form that pairs THIS phone.
//
// Port of web/src/components/paired-devices.tsx, one for one in behaviour:
//   * The registry rides the poll beat while the card is mounted (`GET /api/devices`), as the React
//     route's loader rides revalidation.
//   * The form shows when this device has no credential the bridge would accept: no token, a token a
//     write was refused for, or a registry that says it authenticated as nobody while pairing is on.
//     NOT on a failed read: an unreachable bridge is no evidence this device is unpaired.
//   * The token comes back from `POST /api/pair` exactly once; it is stored before anything else.
//   * `?pair=<code>` (the QR `collie pair` prints) prefills the code once and focuses the name; the
//     spent code leaves the URL with a replace, so Back does not walk into it.
//   * `#paired-devices` scrolls to the card and focuses it (the read-only strip's link).
//   * Revoke is a two-tap confirm; revoking THIS device self-unpairs (the token is dropped).
// Enrolment is out-of-band on purpose: nothing here can mint a code.
import { navigate, on, ref, type Handle } from "remix/component";
import { KeyRound, LoaderCircle, Smartphone } from "lucide";

import { timeAgo } from "@web/lib/format";
import { t } from "@web/lib/i18n";
import { PAIRED_DEVICES_HASH } from "@web/lib/nav";
import type { PairFailure } from "@web/lib/types";

import { useLocale } from "../../lib/i18n-store";
import { clearDeviceToken, pairing, setDeviceToken } from "../../lib/pairing";
import { devices, loadDevices, pairDevice, revokeDevice } from "../../lib/pairing-api";
import { want } from "../../lib/polling";
import { useStore } from "../../lib/store";
import { Button } from "../../ui/button";
import { Card } from "../../ui/card";
import { Icon } from "../../ui/icon";

export const DEVICES_SOURCE = { key: "devices", poll: loadDevices };

/** Split a translated sentence around one known value, so the value keeps its own styling. */
function splitAroundValue(message: string, value: string): [string, string] {
  const idx = message.indexOf(value);
  if (idx === -1) return [message, ""];
  return [message.slice(0, idx), message.slice(idx + value.length)];
}

/** The QR's code, read once, upper-cased like the field. */
function codeFromUrl(): string {
  return (new URLSearchParams(window.location.search).get("pair") ?? "").trim().toUpperCase();
}

export function PairedDevices(handle: Handle) {
  want(DEVICES_SOURCE, handle.signal);
  const readDevices = useStore(handle, devices);
  const readPairing = useStore(handle, pairing);
  useLocale(handle);
  const fromQr = codeFromUrl() !== "";
  let card: HTMLElement | null = null;

  // The two ways in, after the first commit: the strip's link lands on the card, a scan scrolls to it
  // and the form focuses its own name field when it mounts (the registry read decides whether the
  // form shows at all). preventScroll, so the smooth scroll owns the movement.
  handle.queueTask(() => {
    if (window.location.hash !== `#${PAIRED_DEVICES_HASH}` && !fromQr) return;
    card?.scrollIntoView({ block: "start", behavior: "smooth" });
    if (!fromQr) card?.focus({ preventScroll: true });
  });

  return () => {
    const data = readDevices();
    const { token, refused } = readPairing();
    const unpaired = data.loaded && (!token || refused || (data.enforced && data.current === null && !data.error));
    const pairedAs = data.current ? t("settings.devices.pairedAs", { device: data.current }) : null;
    const [before, after] = pairedAs && data.current ? splitAroundValue(pairedAs, data.current) : ["", ""];
    return (
      <Card
        id={PAIRED_DEVICES_HASH}
        tabIndex={-1}
        data-testid="paired-devices"
        class="gap-0 py-0 outline-none"
        mix={ref((node: HTMLDivElement) => {
          card = node;
        })}
      >
        <div class="flex items-start gap-3 p-4 pb-3">
          <Icon icon={KeyRound} class="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div class="min-w-0">
            <div class="font-medium">{t("settings.devices.title")}</div>
            <p class="text-sm text-muted-foreground">
              {data.enforced ? t("settings.devices.description.enforced") : t("settings.devices.description.open")}
            </p>
          </div>
        </div>

        {data.current ? (
          <p class="border-t border-border px-4 py-2.5 text-sm">
            {before}
            <span class="text-[13px] font-medium text-status-done">{data.current}</span>
            {after}
          </p>
        ) : null}

        {data.error ? (
          <p class="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{t("settings.devices.loadError")}</p>
        ) : null}

        {data.devices.length > 0 ? (
          <ul class="divide-y divide-border border-t border-border">
            {data.devices.map((d) => (
              <DeviceRow
                key={d.label}
                label={d.label}
                createdAt={d.createdAt}
                lastSeenAt={d.lastSeenAt}
                current={d.current}
                onRevoked={() => {
                  // The token we still hold now authenticates as nobody: drop it rather than keep a
                  // credential that 403s.
                  if (d.current) clearDeviceToken();
                  void loadDevices();
                }}
              />
            ))}
          </ul>
        ) : null}

        {unpaired ? (
          <PairForm prefilled={codeFromUrl()} onPaired={() => void loadDevices()} />
        ) : null}
      </Card>
    );
  };
}

interface DeviceRowProps {
  label: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
  onRevoked: () => void;
}

function DeviceRow(handle: Handle<DeviceRowProps>) {
  useLocale(handle);
  let confirming = false;
  let busy = false;
  let error: string | null = null;

  async function revoke(): Promise<void> {
    busy = true;
    error = null;
    void handle.update();
    try {
      await revokeDevice(handle.props.label);
      handle.props.onRevoked();
    } catch {
      error = t("settings.devices.revokeError");
    } finally {
      busy = false;
      confirming = false;
      void handle.update();
    }
  }

  return () => {
    const { label, createdAt, lastSeenAt, current } = handle.props;
    return (
      <li class="flex items-center justify-between gap-3 px-4 py-2.5" data-testid="device-row">
        <div class="min-w-0">
          <div class="flex items-center gap-2">
            <Icon icon={Smartphone} class="size-4 shrink-0 text-muted-foreground" />
            <span class="truncate text-[13px] font-medium">{label}</span>
            {current ? (
              <span class="shrink-0 rounded bg-status-done/15 px-1.5 py-0.5 text-[11px] font-medium text-status-done">
                {t("settings.devices.thisDevice")}
              </span>
            ) : null}
          </div>
          <p class="mt-0.5 text-xs text-muted-foreground">
            {t("settings.devices.row.meta", { paired: timeAgo(createdAt), lastSeen: timeAgo(lastSeenAt) })}
          </p>
          {error ? <p class="mt-0.5 text-xs text-status-blocked">{error}</p> : null}
        </div>
        {confirming ? (
          <div class="flex shrink-0 items-center gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              mix={on("click", () => {
                confirming = false;
                void handle.update();
              })}
            >
              {t("settings.devices.cancel")}
            </Button>
            <Button variant="destructive" size="sm" disabled={busy} mix={on("click", () => void revoke())}>
              {busy ? <Icon icon={LoaderCircle} class="size-3.5 animate-spin" /> : null}
              {current ? t("settings.devices.unpairSelf") : t("settings.devices.revoke")}
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            size="sm"
            class="shrink-0"
            aria-label={t("settings.devices.revokeAria", { label })}
            mix={on("click", () => {
              confirming = true;
              void handle.update();
            })}
          >
            {t("settings.devices.revoke")}
          </Button>
        )}
      </li>
    );
  };
}

interface PairFormProps {
  /** The QR's code, or "". Read once, as the field's first value; a code moves focus to the name. */
  prefilled: string;
  onPaired: () => void;
}

/** One actionable sentence per refusal the bridge names (web/'s `failureText`). */
function failureText(reason: PairFailure): string {
  switch (reason) {
    case "no-pending":
      return t("settings.devices.pair.failure.noPending");
    case "expired":
      return t("settings.devices.pair.failure.expired");
    case "exhausted":
      return t("settings.devices.pair.failure.exhausted");
    case "bad-code":
      return t("settings.devices.pair.failure.badCode");
    case "duplicate-label":
      return t("settings.devices.pair.failure.duplicateLabel");
    case "bad-request":
      return t("settings.devices.pair.failure.badRequest");
  }
}

const FIELD =
  "h-11 rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring";

function PairForm(handle: Handle<PairFormProps>) {
  useLocale(handle);
  let code = handle.props.prefilled;
  let label = "";
  let busy = false;
  let error: string | null = null;
  let nameInput: HTMLInputElement | null = null;
  // A scan arrives with the code spelled, so the name is the only thing left to type.
  if (code !== "") handle.queueTask(() => nameInput?.focus({ preventScroll: true }));

  async function submit(): Promise<void> {
    busy = true;
    error = null;
    void handle.update();
    try {
      const res = await pairDevice(code.trim(), label.trim());
      if (!res.ok) {
        error = failureText(res.reason);
        return;
      }
      // The token exists exactly once: store it before anything else.
      setDeviceToken(res.token);
      code = "";
      label = "";
      // The code is spent: drop it from the URL with a replace, so a reload or Back cannot re-offer it.
      const url = new URL(window.location.href);
      if (url.searchParams.has("pair")) {
        url.searchParams.delete("pair");
        void navigate(`${url.pathname}${url.search}${url.hash}`, { history: "replace", resetScroll: false });
      }
      handle.props.onPaired();
    } catch {
      error = t("settings.devices.pair.networkError");
    } finally {
      busy = false;
      void handle.update();
    }
  }

  return () => {
    const ready = code.trim() !== "" && label.trim() !== "" && !busy;
    // The CLI command is never translated; the sentence around it is.
    const command = "bin/collie pair";
    const [hintBefore, hintAfter] = splitAroundValue(t("settings.devices.pair.hint", { command }), command);
    return (
      <div class="flex flex-col gap-3 border-t border-border p-4">
        <div>
          <div class="font-medium">{t("settings.devices.pair.title")}</div>
          <p class="text-sm text-muted-foreground">
            {hintBefore}
            <code class="font-mono text-[13px]">{command}</code>
            {hintAfter}
          </p>
        </div>
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium text-muted-foreground">{t("settings.devices.pair.codeLabel")}</span>
          <input
            value={code}
            placeholder={t("settings.devices.pair.codePlaceholder")}
            autoCapitalize="characters"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            aria-label={t("settings.devices.pair.codeLabel")}
            class={`${FIELD} font-mono tracking-widest`}
            mix={on("input", (event) => {
              code = event.currentTarget.value.toUpperCase();
              void handle.update();
            })}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-xs font-medium text-muted-foreground">{t("settings.devices.pair.nameLabel")}</span>
          <input
            value={label}
            placeholder={t("settings.devices.pair.namePlaceholder")}
            autoCorrect="off"
            autoComplete="off"
            aria-label={t("settings.devices.pair.nameLabel")}
            class={FIELD}
            mix={[
              ref((node: HTMLInputElement) => {
                nameInput = node;
              }),
              on("input", (event) => {
                label = event.currentTarget.value;
                void handle.update();
              }),
            ]}
          />
        </label>
        {error ? <p class="text-xs text-status-blocked">{error}</p> : null}
        <Button class="h-11" disabled={!ready} mix={on("click", () => void submit())}>
          {busy ? <Icon icon={LoaderCircle} class="size-4 animate-spin" /> : null}
          {t("settings.devices.pair.title")}
        </Button>
      </div>
    );
  };
}
