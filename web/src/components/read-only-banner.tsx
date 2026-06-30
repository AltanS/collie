import { Lock } from "lucide-react";

import { isReadOnly } from "@/lib/types";
import type { DeviceAuth } from "@/lib/types";
import { cn } from "@/lib/utils";

// Shown when the bridge enforces per-device auth and this device isn't on the allowlist: the UI
// drops to read-only (the backend rejects every terminal-driving action anyway). Renders nothing
// when the feature is off, the device is authorised, or the state isn't known yet — so it costs
// nothing on a normal single-user deployment. `device` comes from the snapshot (HomeData.device).
export function ReadOnlyBanner({
  device,
  className,
}: {
  device: DeviceAuth | undefined;
  className?: string;
}) {
  if (!isReadOnly(device)) return null;
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 border-b border-status-working/40 bg-status-working/15 px-4 py-2 text-xs font-medium text-status-working",
        className,
      )}
    >
      <Lock className="size-3.5 shrink-0" />
      <span>
        Read-only — this device isn’t authorised to type into agents
        {device?.device ? ` (${device.device})` : ""}.
      </span>
    </div>
  );
}
