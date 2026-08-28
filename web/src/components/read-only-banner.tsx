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

  return (
    // Nothing at all is rendered inside once the gate lifts, and that is the whole shape of a
    // converted notice: `ui/collapse.tsx` HOLDS the last non-empty children and renders them for the
    // full exit, so the box still slides shut on the sentence that explained it. This file used to
    // carry its own ref for that, latched in an effect; the primitive carries it now, because the
    // six conversions after this one would each have hand-rolled the same ref.
    //
    // The gutter, and only the gutter — `mx-4 mt-3` on the routes, `mx-3 mt-1.5` in the pane. It
    // rides the COLLAPSE rather than the Notice: the row is the thing whose height animates, so a
    // margin on it is part of the same movement. (Either is now geometrically sound — the box no
    // longer carries `w-full`, so at 390px `mx-4` on it measures 358px with 16px on both sides.
    // Before that fix a margin on the box resolved 100% against the FULL row and was then offset by
    // it, hanging past the right edge, and the row was the only correct owner.) One cost stays,
    // small and real: `mt-3` sits outside the animated row, so 12px of the space arrives at once
    // and the 50px box slides in behind it. Moving the gutter inward is what would close that, and
    // it is a decision about every converted notice, not about this one.
    <Collapse open={gate !== null} className={className}>
      {gate ? (
        <Notice
          variant="box"
          tone="caution"
          announce="status"
          icon={gate === "pairing" ? <KeyRound /> : <Lock />}
        >
          {gate === "pairing"
            ? t("connection.readOnly.notPaired")
            : t("connection.readOnly.device", { deviceSuffix })}
        </Notice>
      ) : null}
    </Collapse>
  );
}
