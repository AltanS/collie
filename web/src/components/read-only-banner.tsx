import type { ReactNode } from "react";
import { KeyRound, Lock } from "lucide-react";

import { usePairing } from "@/lib/pairing";
import { isReadOnly } from "@/lib/types";
import type { DeviceAuth } from "@/lib/types";
import { cn } from "@/lib/utils";

// The app's "you can look, but you can't type" strip, covering BOTH write gates — they are
// independent on the bridge and compose by AND, so either one alone puts this device in the same
// place, and one strip is the honest surface for it. Renders nothing when neither gate refuses, so
// it still costs nothing on a normal single-user deployment.
//
//   · Header gate (`device`, from the snapshot): a fronting proxy asserts who this device is and the
//     bridge doesn't have it allowlisted. Nothing on the phone can fix it.
//   · Pairing gate (lib/pairing.ts): this device holds no bearer token, or the one it holds was
//     rejected. Fixable right here, which is why this variant names the remedy. It is LATCHED off a
//     real refusal rather than polled, because reads are ungated — a poll can never discover it.
export function ReadOnlyBanner({
  device,
  className,
}: {
  device: DeviceAuth | undefined;
  className?: string;
}) {
  const { refused } = usePairing();

  if (refused) {
    return (
      <Strip className={className} icon={<KeyRound className="size-3.5 shrink-0" />}>
        Not paired — pair this device in Settings to type into agents.
      </Strip>
    );
  }
  if (!isReadOnly(device)) return null;
  return (
    <Strip className={className} icon={<Lock className="size-3.5 shrink-0" />}>
      Read-only — this device isn’t authorised to type into agents
      {device?.device ? ` (${device.device})` : ""}.
    </Strip>
  );
}

function Strip({
  icon,
  children,
  className,
}: {
  icon: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 border-b border-status-working/40 bg-status-working/15 px-4 py-2 text-xs font-medium text-status-working",
        className,
      )}
    >
      {icon}
      <span>{children}</span>
    </div>
  );
}
