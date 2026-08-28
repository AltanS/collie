import { useState } from "react";
import { KeyRound, Loader2, Smartphone } from "lucide-react";
import { useRevalidator } from "react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { pairDevice, revokeDevice } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { clearDeviceToken, setDeviceToken, usePairing } from "@/lib/pairing";
import type { DevicesData } from "@/lib/loaders";
import type { PairFailure } from "@/lib/types";

// Splits a translated sentence around ONE already-known substring (a name, a device id, a CLI
// command) so that substring can carry its own styling — a `<span>`/`<code>` — instead of the whole
// sentence losing its font. The split happens on the INTERPOLATED value, after `t()` has placed it,
// so a translator is free to reorder the sentence around it; this only locates where the slot
// landed, it never assembles the sentence itself.
function splitAroundValue(message: string, value: string): [string, string] {
  const idx = message.indexOf(value);
  if (idx === -1) return [message, ""];
  return [message.slice(0, idx), message.slice(idx + value.length)];
}

// The Settings surface for the bridge's second write gate (bridge/pairing.ts): who is paired, and
// the card that pairs THIS phone. State comes from the settings route's loader (lib/loaders.ts
// devicesLoader) and every mutation is an api call followed by `revalidator.revalidate()` — the same
// shape as every other write in the app.
//
// Enrolment is deliberately out-of-band: the operator runs `bin/collie pair` in a terminal on the
// host and types the 8-character code in here. Nothing on this screen can mint a code, which is the
// whole point — a phone that could ask for one would be a phone that could pair itself.

export function PairedDevices({ data }: { data: DevicesData }) {
  useLocale();
  const revalidator = useRevalidator();
  const { token, refused } = usePairing();

  // Show the pairing form when this device has no credential the bridge would accept: it holds no
  // token, its token was rejected by a write, or the registry itself says it authenticated as
  // nobody while pairing is on. Deliberately NOT shown on a failed load — an unreachable bridge is
  // not evidence that this device is unpaired.
  const unpaired = !token || refused || (data.enforced && data.current === null && !data.error);

  const pairedAsMessage = data.current
    ? t("settings.devices.pairedAs", { device: data.current })
    : null;
  const [pairedAsBefore, pairedAsAfter] =
    pairedAsMessage && data.current ? splitAroundValue(pairedAsMessage, data.current) : ["", ""];

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4 pb-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">{t("settings.devices.title")}</div>
          <p className="text-sm text-muted-foreground">
            {data.enforced
              ? t("settings.devices.description.enforced")
              : t("settings.devices.description.open")}
          </p>
        </div>
      </div>

      {data.current && (
        <p className="border-t border-border px-4 py-2.5 text-sm">
          {pairedAsBefore}
          <span className="text-[13px] font-medium text-status-done">{data.current}</span>
          {pairedAsAfter}
        </p>
      )}

      {data.error && (
        <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
          {t("settings.devices.loadError")}
        </p>
      )}

      {data.devices.length > 0 && (
        <ul className="divide-y divide-border border-t border-border">
          {data.devices.map((d) => (
            <DeviceRow
              key={d.label}
              label={d.label}
              createdAt={d.createdAt}
              lastSeenAt={d.lastSeenAt}
              current={d.current}
              onRevoked={() => {
                // Revoking yourself is allowed and self-unpairs: the token we still hold now
                // authenticates as nobody, so drop it rather than keep a credential that 403s.
                if (d.current) clearDeviceToken();
                revalidator.revalidate();
              }}
            />
          ))}
        </ul>
      )}

      {unpaired && <PairForm onPaired={() => revalidator.revalidate()} />}
    </Card>
  );
}

function DeviceRow({
  label,
  createdAt,
  lastSeenAt,
  current,
  onRevoked,
}: {
  label: string;
  createdAt: number;
  lastSeenAt: number;
  current: boolean;
  onRevoked: () => void;
}) {
  useLocale();
  // Two-tap confirm rather than a dialog: revoking is irreversible (the token can't be re-issued,
  // only re-paired from a fresh `bin/collie pair`), and revoking THIS device locks the phone you're
  // holding out of every write — so the second tap names that consequence instead of asking "sure?".
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await revokeDevice(label);
      onRevoked();
    } catch {
      setError(t("settings.devices.revokeError"));
    } finally {
      setBusy(false);
      setConfirming(false);
    }
  }

  return (
    <li className="flex items-center justify-between gap-3 px-4 py-2.5">
      <div className="min-w-0">
        <div className="flex items-center gap-2">
          <Smartphone className="size-4 shrink-0 text-muted-foreground" />
          {/* A device name the operator typed, in the app's own face — the same face the field
              that captures it uses below. Only the pairing CODE is monospaced, because that one is
              eight characters you compare against a terminal. */}
          <span className="truncate text-[13px] font-medium">{label}</span>
          {current && (
            <span className="shrink-0 rounded bg-status-done/15 px-1.5 py-0.5 text-[11px] font-medium text-status-done">
              {t("settings.devices.thisDevice")}
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t("settings.devices.row.meta", {
            paired: timeAgo(createdAt),
            lastSeen: timeAgo(lastSeenAt),
          })}
        </p>
        {error && <p className="mt-0.5 text-xs text-status-blocked">{error}</p>}
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
            {t("settings.devices.cancel")}
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={revoke}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {current ? t("settings.devices.unpairSelf") : t("settings.devices.revoke")}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setConfirming(true)}
          aria-label={t("settings.devices.revokeAria", { label })}
        >
          {t("settings.devices.revoke")}
        </Button>
      )}
    </li>
  );
}

function PairForm({ onPaired }: { onPaired: () => void }) {
  useLocale();
  const [code, setCode] = useState("");
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const ready = code.trim() !== "" && label.trim() !== "" && !busy;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const res = await pairDevice(code.trim(), label.trim());
      if (!res.ok) {
        setError(failureText(res.reason));
        return;
      }
      // The token comes back exactly once and is not recoverable — store it before anything else.
      setDeviceToken(res.token);
      setCode("");
      setLabel("");
      onPaired();
    } catch {
      setError(t("settings.devices.pair.networkError"));
    } finally {
      setBusy(false);
    }
  }

  // The CLI command itself is never translated (rule: CLI commands stay literal); the surrounding
  // sentence is, so the command is placed via the same "locate the interpolated value" split as the
  // paired-as sentence above, letting it keep its own <code> styling.
  const command = "bin/collie pair";
  const hintMessage = t("settings.devices.pair.hint", { command });
  const [hintBefore, hintAfter] = splitAroundValue(hintMessage, command);

  return (
    <div className="flex flex-col gap-3 border-t border-border p-4">
      <div>
        <div className="font-medium">{t("settings.devices.pair.title")}</div>
        <p className="text-sm text-muted-foreground">
          {hintBefore}
          <code className="font-mono text-[13px]">{command}</code>
          {hintAfter}
        </p>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t("settings.devices.pair.codeLabel")}
        </span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder={t("settings.devices.pair.codePlaceholder")}
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-label={t("settings.devices.pair.codeLabel")}
          className="h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm tracking-widest focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">
          {t("settings.devices.pair.nameLabel")}
        </span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder={t("settings.devices.pair.namePlaceholder")}
          autoCorrect="off"
          autoComplete="off"
          aria-label={t("settings.devices.pair.nameLabel")}
          className="h-11 rounded-lg border border-border bg-background px-3 text-sm focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        />
      </label>
      {error && <p className="text-xs text-status-blocked">{error}</p>}
      <Button className="h-11" disabled={!ready} onClick={submit}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        {t("settings.devices.pair.title")}
      </Button>
    </div>
  );
}

// One actionable sentence per refusal the bridge names. Each says what happened AND what to do next
// — "invalid code" would be true and useless, since three of these are only fixable at the host.
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
