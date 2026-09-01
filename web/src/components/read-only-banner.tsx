import { ChevronRight, KeyRound, Lock } from "lucide-react";
import { Link } from "react-router";

import { Collapse } from "@/components/ui/collapse";
import { Notice } from "@/components/ui/notice";
import { usePairing } from "@/lib/pairing";
import { isReadOnly } from "@/lib/types";
import type { DeviceAuth } from "@/lib/types";
import { t } from "@/lib/i18n";
import { pairedDevicesPath } from "@/lib/nav";
import { useScope } from "@/lib/session";
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
//     rejected. Fixable right here, which is why this variant names the remedy AND is the way to
//     it: the pairing strip is a link to the Paired-devices card in Settings. It is LATCHED off a
//     real refusal rather than polled, because reads are ungated — a poll can never discover it.
//
// This file knows the CONDITION, the words for it and, for the pairing gate, where the remedy is.
// After the ui/notice.tsx migration it owns no LOOK at all: the tinted band, its floor and its live
// region are the primitive's; the one class here is the link wrapper's `block`, which is layout.
// It takes no `className` either, which is the strip contract rather than an omission — a strip is full-bleed
// viewport chrome and there is no gutter for a caller to set (DESIGN.md §4). If a future change
// wants this to look different, the change belongs in ui/notice.tsx where every notice gets it.
//
// ── A STRIP, NOT A BOX, AND THAT IS A SPACE DECISION WITH A REASON ───────────
// It was a box: 42px minimum, wrapping to two lines in five of six locales, ~50px, plus a 12px
// gutter. On a phone with the soft keyboard up that is more vertical space than the pane-switch
// handle and the agent's statusline COMBINED — and this is a standing condition that never changes
// for the life of the device, sitting above a mirror that had been squeezed to zero rows. A box is
// for a fact you must read and act on; a strip is for a condition you must be able to SEE. This is
// the second kind: nothing about it is actionable from here except the pairing case, whose remedy
// is named in the sentence and lives in Settings.
//
// It is also stated twice already. The composer is disabled and its own placeholder reads
// "Read-only — not authorised" at the exact point of refusal, which DESIGN.md calls the stronger
// place. This strip is the standing disclosure; the placeholder is the answer at the moment it
// matters.
//
// The copy is the SHORT pair, `space.readOnly.*`, which was already written and already translated
// into all six locales for the space route and used by nothing. A strip never wraps, by contract
// (ui/notice.tsx), so long copy would truncate rather than fit — and the short strings are what the
// contract asks for. The one thing they drop is the device NAME suffix, which was answering "which
// device is this?" on the device you are holding.
//
// tone="caution": a refused write gate is a degraded capability, not a neutral fact — the composer
// and the tab strip are dead while it stands, and the operator has to know why. It maps to
// `--status-working`, which is the exact token this banner already used, so no colour changes here.
//
// announce="status": role="status", polite, which is what the `<output>` element this replaces
// already meant implicitly. Polite and not "alert" because the usual case is a box that is TRUE AT
// FIRST PAINT (read-only is known at loader time), where there is nothing to interrupt; the case
// worth announcing is the mid-session pairing latch, and interrupting the operator assertively
// mid-keystroke to say a key they just pressed did nothing is louder than the fact deserves. Not
// "none", because that latch is a real change and dropping the region would make it silent.
export function ReadOnlyBanner({ device }: { device: DeviceAuth | undefined }) {
  useLocale();
  const { refused } = usePairing();
  // The scope rides the link like every other navigation in the app (lib/nav.ts): Settings' own back
  // button goes to `homePath(scope)`, so a scope-less link here would strand the operator on the
  // lead's dashboard after they paired. The banner is never mounted outside the router.
  const scope = useScope();

  // The pairing latch is checked FIRST and outranks the device gate: both can be true at once, and
  // only the pairing one names a remedy the phone can actually carry out.
  const gate: Gate | null = refused ? "pairing" : isReadOnly(device) ? "device" : null;

  return (
    // Nothing at all is rendered inside once the gate lifts, and that is the whole shape of a
    // converted notice: `ui/collapse.tsx` HOLDS the last non-empty children and renders them for the
    // full exit, so the box still slides shut on the sentence that explained it. This file used to
    // carry its own ref for that, latched in an effect; the primitive carries it now, because the
    // six conversions after this one would each have hand-rolled the same ref.
    //
    // THE GUTTER IS GONE, AND ITS WHOLE ARGUMENT WITH IT. A box carried `mx-4 mt-3` on the routes
    // and `mx-3 mt-1.5` in the pane, and that margin had to ride the NOTICE rather than the Collapse
    // — `grid-template-rows` interpolates the height of the grid ITEM, so a margin on the container
    // around it was never part of what animated, and 12px of space arrived at once with the box
    // sliding in behind it. A strip is full-bleed and has no margin at all, so there is nothing left
    // outside the measured item and the slide is one continuous movement by construction.
    <Collapse open={gate !== null}>
      {gate === "pairing" ? (
        // ONLY THIS GATE IS A LINK, and that asymmetry is the point: the sentence already says
        // "pair this device in Settings", so the strip may as well BE the way there. The device gate
        // has no remedy on the phone (a proxy asserts the name and the bridge's allowlist is on the
        // host), so making it tappable would promise a fix that does not exist.
        //
        // A `<Link>` WRAPPING the primitive, not a prop on it. `ui/notice.tsx` already has
        // `onActivate`, but that renders a `<button>`, and this is a navigation: an anchor is what
        // carries a destination into the accessibility tree, what a long-press offers to open in a
        // new tab, and what the browser shows on hover. Wrapping keeps the primitive untouched —
        // the tinted band, the 33px floor and the `role="status"` on the body are still its.
        //
        // `block` is layout, not styling: an inline anchor around the strip's block root sizes to
        // its own line box, which is the same fault the primitive's `w-full` note describes. The
        // accessible name is the sentence inside; the chevron is decorative and says so.
        <Link to={pairedDevicesPath(scope)} className="block">
          <Notice
            variant="strip"
            tone="caution"
            announce="status"
            icon={<KeyRound />}
            action={<ChevronRight aria-hidden className="size-3.5 opacity-70" />}
          >
            {t("space.readOnly.notPaired")}
          </Notice>
        </Link>
      ) : gate === "device" ? (
        <Notice variant="strip" tone="caution" announce="status" icon={<Lock />}>
          {t("space.readOnly.deviceUnauthorised")}
        </Notice>
      ) : null}
    </Collapse>
  );
}
