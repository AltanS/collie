import { Button } from "@/components/ui/button";
import { CollieMark } from "@/components/collie-mark";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

// The cover shown while the idle lock is engaged. It sits ABOVE a still-mounted router (see App), so
// resuming returns you to the exact screen, draft and scroll position you left — nothing is unmounted
// and nothing is rebuilt.
//
// It is deliberately GLASS rather than opaque. The cover's job is to say "this is frozen, not live" —
// a paused mirror read as a current one is the actual hazard — and it does that better while the herd
// stays legible underneath: you can see WHAT is stale instead of losing the screen entirely. The
// trade is that an unattended screen no longer hides agent output; that's accepted, because the
// device's own screen lock is the thing that was ever going to handle shoulder-surfing.
//
// It leads with the Collie mark for a plain reason: this is the one screen in the app with no header,
// no herd chrome and no nav, so without it a full-viewport panel is unattributable — it could be any
// app that happened to be open. The mark is <CollieMark/> still, and never <DogGallop/>:
// that sprite's rest frame is a full-stretch mid-stride pose that reads as "frozen mid-run", and this
// screen is the app's most literal rest state. The paused state carries no `loading` — the pause is
// not work in flight; the catch-up refetch is, and it blooms the same mark (see below).
//
// No lock iconography and no "for safety" — the pause guards nothing (.adr/0007). Saying otherwise
// would promise a gate that a page reload has always walked straight through.
interface IdleLockProps {
  onUnlock: () => void;
  /** The refetch fired on resume is still in flight — hold the cover and bloom the mark rather than
   *  dropping straight back onto the frozen screen this panel just warned about. */
  catchingUp?: boolean;
}

export function IdleLock({ onUnlock, catchingUp = false }: IdleLockProps) {
  useLocale();
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("idle.dialogAria")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/40 px-6 backdrop-blur-[3px]"
    >
      {/* The panel carries its own, heavier blur so the copy stays readable over arbitrary pane text,
          while the scrim above keeps the herd recognisable behind it. */}
      <div className="flex flex-col items-center gap-6 rounded-3xl border border-border/60 bg-card/70 px-8 py-10 text-center shadow-2xl ring-1 ring-white/10 backdrop-blur-2xl">
        <div className="flex flex-col items-center gap-3">
          {/* ONE mark in both states, in one 80px box, so the panel's geometry never shifts as the
              resume fetch starts and finishes — nothing is swapped and nothing can resize. The
              catch-up is the bloom: the orbit speeds up AND the accents come to full chroma, which
              is the half that still says "working" under `prefers-reduced-motion`, where the turning
              stops. It also means one animal everywhere in the app: the mark blooms while Collie is
              fetching, on this cover exactly as in the header. The "Catching up" copy below carries
              the accessible meaning, so the mark stays decorative.

              No disc and no ring around it. The disc existed for the sprite that used to sit here —
              a transparent cut-out that would otherwise float on the glass. The mark brings its own
              ring (the orbit IS the frame) and an `overflow-hidden` circle would only clip the beads
              that pass widest.

              `paper` is the knockout that puts a near-side bead in FRONT of the head, so it has to be
              the ground the mark sits on. Here that ground is the glass panel, `bg-card/70` over a
              blurred herd — genuinely translucent, so there is no exact colour to name. `var(--card)`
              is the panel's own token and the closest honest answer; it is right in both themes and
              only ever a shade off through the blur. That is also the second reason there is no disc:
              it would put a lighter, half-transparent layer between the mark and any colour we could
              name. */}
          <span className="grid size-20 shrink-0 place-items-center">
            <CollieMark size={64} weight="header" loading={catchingUp} paper="var(--card)" />
          </span>
          <span className="text-lg font-semibold tracking-tight">Collie</span>
        </div>
        {catchingUp ? (
          <div className="space-y-1">
            <p className="font-medium">{t("idle.catchingUp.title")}</p>
            <p className="max-w-xs text-sm text-muted-foreground">{t("idle.catchingUp.body")}</p>
          </div>
        ) : (
          <div className="space-y-1">
            <p className="font-medium">{t("idle.paused.title")}</p>
            <p className="max-w-xs text-sm text-muted-foreground">{t("idle.paused.body")}</p>
          </div>
        )}
        {/* The button doesn't just disable during the catch-up — it's removed, and the mark above
            blooms in its place, so there's nothing to press twice and no dead control to look at. */}
        {!catchingUp && (
          <Button size="lg" onClick={onUnlock}>
            {t("idle.resume")}
          </Button>
        )}
      </div>
    </div>
  );
}
