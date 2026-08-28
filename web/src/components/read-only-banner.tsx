import { useEffect, useRef } from "react";
import { KeyRound, Lock } from "lucide-react";

import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import { usePairing } from "@/lib/pairing";
import { isReadOnly } from "@/lib/types";
import type { DeviceAuth } from "@/lib/types";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

/** Which write gate refused. They are independent on the bridge; pairing outranks. */
type Gate = "pairing" | "device";

// The app's "you can look, but you can't type" notice, covering BOTH write gates — they are
// independent on the bridge and compose by AND, so either one alone puts this device in the same
// place, and one notice is the honest surface for it. Renders nothing when neither gate refuses, so
// it still costs nothing on a normal single-user deployment.
//
//   · Header gate (`device`, from the snapshot): a fronting proxy asserts who this device is and the
//     bridge doesn't have it allowlisted. Nothing on the phone can fix it.
//   · Pairing gate (lib/pairing.ts): this device holds no bearer token, or the one it holds was
//     rejected. Fixable right here, which is why this variant names the remedy. It is LATCHED off a
//     real refusal rather than polled, because reads are ungated — a poll can never discover it.
//
// This file knows the CONDITION and the words for it, and after the ui/notice.tsx migration it owns
// no styling at all: the tinted box, its floor, its radius and its live region are the primitive's,
// and the `className` it forwards is the caller's GUTTER and nothing else (DESIGN.md §1). If a
// future change wants a different-looking box here, the change belongs in ui/notice.tsx where every
// notice gets it, not in a className passed from this file.
//
// tone="caution": a refused write gate is a degraded capability, not a neutral fact — the composer
// and the tab strip are dead while it stands, and the operator has to know why. It maps to
// `--status-working`, which is the exact token this banner already used, so no colour changes here.
// The SIZE changes in one case, deliberately: this box wraps to two lines in five of six locales
// (50px at 390px, unchanged), and the one locale that fits on one line — Chinese — went from 34px to
// the primitive's 42px floor. That 8px is the floor doing the job it was written for: two one-line
// notices anywhere in the app are now the same height whether or not one of them carries a button.
//
// announce="status": role="status", polite, which is what the `<output>` element this replaces
// already meant implicitly. Polite and not "alert" because the usual case is a box that is TRUE AT
// FIRST PAINT (read-only is known at loader time), where there is nothing to interrupt; the case
// worth announcing is the mid-session pairing latch, and interrupting the operator assertively
// mid-keystroke to say a key they just pressed did nothing is louder than the fact deserves. Not
// "none", because that latch is a real change and dropping the region would make it silent.
export function ReadOnlyBanner({
  device,
  className,
}: {
  device: DeviceAuth | undefined;
  className?: string;
}) {
  useLocale();
  const { refused } = usePairing();

  // The pairing latch is checked FIRST and outranks the device gate: both can be true at once, and
  // only the pairing one names a remedy the phone can actually carry out.
  const gate: Gate | null = refused ? "pairing" : isReadOnly(device) ? "device" : null;
  const deviceSuffix = device?.device ? ` (${device.device})` : "";

  // Collapse keeps its child mounted through the exit, but it does not SNAPSHOT it — the child is
  // whatever this render returns, and the moment the gate lifts, the words that described it are
  // gone. So the last true gate is held here and keeps being rendered while the box slides shut.
  // Without this the box empties one frame into a 240ms exit and closes on nothing, which is the
  // same pop, just quieter. The latch is written in an effect rather than during render so this
  // component stays pure: the effect for the render that SHOWED the notice has already run by the
  // time a render needs to read it back.
  const shown = useRef<{ gate: Gate; deviceSuffix: string }>({ gate: "device", deviceSuffix: "" });
  useEffect(() => {
    if (gate) shown.current = { gate, deviceSuffix };
  }, [gate, deviceSuffix]);

  const last = gate ? { gate, deviceSuffix } : shown.current;

  return (
    // The gutter, and only the gutter — `mx-4 mt-3` on the routes, `mx-3 mt-1.5` in the pane. It
    // rides the COLLAPSE, not the Notice, and that is measured rather than preferred: `ui/notice.tsx`
    // gives a box `w-full`, so a margin on the box resolves 100% against the FULL row and then
    // offsets it — at 390px the box came out 378px wide starting 12px in, i.e. 12px past the right
    // edge and clipped, with the right gutter simply gone. Inset the row and the box fills what is
    // left, which is what `w-full` is there for. Cost, and it is small but real: the top margin is
    // outside the animated row, so 12px of the space arrives at once and 50px slides in behind it.
    <Collapse open={gate !== null} className={className}>
      <Notice
        variant="box"
        tone="caution"
        announce="status"
        icon={last.gate === "pairing" ? <KeyRound /> : <Lock />}
      >
        {last.gate === "pairing"
          ? t("connection.readOnly.notPaired")
          : t("connection.readOnly.device", { deviceSuffix: last.deviceSuffix })}
      </Notice>
    </Collapse>
  );
}
