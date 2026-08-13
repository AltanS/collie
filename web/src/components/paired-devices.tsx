import { useState } from "react";
import { KeyRound, Loader2, Smartphone } from "lucide-react";
import { useRevalidator } from "react-router";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { pairDevice, revokeDevice } from "@/lib/api";
import { timeAgo } from "@/lib/format";
import { clearDeviceToken, setDeviceToken, usePairing } from "@/lib/pairing";
import type { DevicesData } from "@/lib/loaders";
import type { PairFailure } from "@/lib/types";

// The Settings surface for the bridge's second write gate (bridge/pairing.ts): who is paired, and
// the card that pairs THIS phone. State comes from the settings route's loader (lib/loaders.ts
// devicesLoader) and every mutation is an api call followed by `revalidator.revalidate()` — the same
// shape as every other write in the app.
//
// Enrolment is deliberately out-of-band: the operator runs `bin/collie pair` in a terminal on the
// host and types the 8-character code in here. Nothing on this screen can mint a code, which is the
// whole point — a phone that could ask for one would be a phone that could pair itself.

export function PairedDevices({ data }: { data: DevicesData }) {
  const revalidator = useRevalidator();
  const { token, refused } = usePairing();

  // Show the pairing form when this device has no credential the bridge would accept: it holds no
  // token, its token was rejected by a write, or the registry itself says it authenticated as
  // nobody while pairing is on. Deliberately NOT shown on a failed load — an unreachable bridge is
  // not evidence that this device is unpaired.
  const unpaired = !token || refused || (data.enforced && data.current === null && !data.error);

  return (
    <Card className="gap-0 py-0">
      <div className="flex items-start gap-3 p-4 pb-3">
        <KeyRound className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0">
          <div className="font-medium">Paired devices</div>
          <p className="text-sm text-muted-foreground">
            {data.enforced
              ? "Every write needs a paired device. Reading stays open."
              : "Nothing is paired, so writes are ungated. Pair a device to require a credential."}
          </p>
        </div>
      </div>

      {data.current && (
        <p className="border-t border-border/60 px-4 py-2.5 text-sm">
          This device is paired as{" "}
          <span className="font-mono text-[13px] text-status-done">{data.current}</span>.
        </p>
      )}

      {data.error && (
        <p className="border-t border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
          Couldn’t load the paired devices from the bridge.
        </p>
      )}

      {data.devices.length > 0 && (
        <ul className="divide-y divide-border/60 border-t border-border/60">
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
      setError("Couldn’t revoke that device.");
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
          <span className="truncate font-mono text-[13px]">{label}</span>
          {current && (
            <span className="shrink-0 rounded bg-status-done/15 px-1.5 py-0.5 text-[11px] font-medium text-status-done">
              This device
            </span>
          )}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          Paired {timeAgo(createdAt)} · last seen {timeAgo(lastSeenAt)}
        </p>
        {error && <p className="mt-0.5 text-xs text-status-blocked">{error}</p>}
      </div>
      {confirming ? (
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(false)}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" disabled={busy} onClick={revoke}>
            {busy && <Loader2 className="size-3.5 animate-spin" />}
            {current ? "Unpair this phone" : "Revoke"}
          </Button>
        </div>
      ) : (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setConfirming(true)}
          aria-label={`Revoke ${label}`}
        >
          Revoke
        </Button>
      )}
    </li>
  );
}

function PairForm({ onPaired }: { onPaired: () => void }) {
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
      setError("Couldn’t reach the bridge to pair. Check the connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 border-t border-border/60 p-4">
      <div>
        <div className="font-medium">Pair this device</div>
        <p className="text-sm text-muted-foreground">
          Run <code className="font-mono text-[13px]">bin/collie pair</code> on the host and type the
          code it prints.
        </p>
      </div>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Pairing code</span>
        <input
          value={code}
          onChange={(e) => setCode(e.target.value.toUpperCase())}
          placeholder="8 characters"
          autoCapitalize="characters"
          autoCorrect="off"
          autoComplete="off"
          spellCheck={false}
          aria-label="Pairing code"
          className="h-11 rounded-lg border border-border bg-background px-3 font-mono text-sm tracking-widest outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs font-medium text-muted-foreground">Name for this device</span>
        <input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="e.g. my phone"
          autoCorrect="off"
          autoComplete="off"
          aria-label="Name for this device"
          className="h-11 rounded-lg border border-border bg-background px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
        />
      </label>
      {error && <p className="text-xs text-status-blocked">{error}</p>}
      <Button className="h-11" disabled={!ready} onClick={submit}>
        {busy && <Loader2 className="size-4 animate-spin" />}
        Pair this device
      </Button>
    </div>
  );
}

// One actionable sentence per refusal the bridge names. Each says what happened AND what to do next
// — "invalid code" would be true and useless, since three of these are only fixable at the host.
function failureText(reason: PairFailure): string {
  switch (reason) {
    case "no-pending":
      return "No pairing code is waiting. Run `bin/collie pair` on the host to mint one.";
    case "expired":
      return "That code has expired. Run `bin/collie pair` on the host for a fresh one.";
    case "exhausted":
      return "Too many wrong codes, so that pairing was destroyed. Run `bin/collie pair` on the host to mint a new one.";
    case "bad-code":
      return "That code doesn’t match. Check it and try again — a few more wrong tries and it’s destroyed.";
    case "duplicate-label":
      return "A device is already using that name. Pick a different one — the code is still good.";
    case "bad-request":
      return "The code or the name wasn’t usable. A name is 1–48 characters.";
  }
}
