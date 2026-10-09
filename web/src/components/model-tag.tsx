import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { modelLabel } from "@/lib/model-label";

// THE PANE'S MODEL, SMALL, ABOVE THE BELT. Altan asked for the selected model "somewhere subtle and
// super small above the belt, floating and at all times": which brain is answering is a fact he
// checks before he sends, and until now it was one tap away inside the Model command.
//
// IT FLOATS ON THE MIRROR'S BOTTOM-RIGHT CORNER, inside the same `relative` box the terminal-draft
// notice's slot pins to (agent-chat.tsx). Absolute, so it changes the height of nothing: not the
// scroller, not the card dock, not the chrome block (DESIGN.md §2). It is not a floating LAYER in the
// sense of ui/sheet.tsx: it is anchored to the pane, scrolls with nothing, takes no touch
// (`pointer-events-none`, so a tap on it reaches the mirror under it) and holds no control. The
// right corner because terminal and chat text both start at the left, and the centre belongs to the
// jump-to-latest button. Under the notice slot's `z-20`, so a draft notice covers it while it shows.
//
// 10px on a 12px line box, the caption size the belt's own tags use, on a translucent page ground so
// the mirror's last row stays readable through it. Absent, never a placeholder: no model, no label.
//
// IT DRAWS NOTHING WHILE THE SCREEN NAMES THE MODEL. The caller passes no model then (agent-chat.tsx
// asks hooks/use-model-on-screen.ts), so a statusline that prints "Opus 5.5" is not doubled. The tag
// is absolute either way, so it arriving or leaving moves nothing (DESIGN.md §2): there is no line to
// reserve because it owns none.

export function ModelTag({ model }: { model: string | undefined }) {
  useLocale();
  const label = modelLabel(model);
  if (label === null) return null;
  return (
    <div
      data-slot="model-tag"
      className="pointer-events-none absolute right-3 bottom-1 z-10 max-w-[45%] truncate rounded-[2px] bg-background/75 px-1 text-[10px]/3 text-muted-foreground"
    >
      <span aria-hidden>{label}</span>
      <span className="sr-only">{t("chat.model.aria", { name: label })}</span>
    </div>
  );
}
