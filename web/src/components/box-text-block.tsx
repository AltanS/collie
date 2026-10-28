import type { BoxTextModel } from "@/lib/blocks";
import { OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

export interface BoxTextBlockProps {
  /** The titled box the grammar read off the pane: its title and its rows, links already found. */
  boxText: BoxTextModel;
}

const LINK_CLASS = "underline decoration-1 underline-offset-2 break-all cursor-pointer py-[0.35em]";

// A titled box the agent printed over its live input box, rendered as text with its links live.
//
// Like the completion popup it has no controls, and that is the design: the input box is live under
// it, so the composer stays free, and the only thing the operator needs from the box is to read it
// and open the address it prints. The panel gets no `raw`, so it draws no Terminal control. A link
// is a plain anchor, so it opens on a tap, takes keyboard focus in reading order and opens on Enter,
// on a read-only device and a gone pane alike: opening an address sends nothing to the terminal.
//
// Text is React text nodes only; an address reaches an href only through the http(s)-only scanner
// that found it (lib/links.ts). A row is `whitespace-pre-wrap` so the box's own spaces survive and a
// row wider than the card wraps instead of being cut or panned. A box that holds its title alone is
// `waiting`: the card shows the title as printed and Collie's own line saying nothing has printed yet.
export function BoxTextBlock({ boxText }: BoxTextBlockProps) {
  useLocale();
  return (
    <PromptPanel ariaLabel={t("dialog.authBox.label")}>
      <OptionGroupCaption>{boxText.title}</OptionGroupCaption>
      {boxText.phase === "waiting" && <div className="text-[12px] leading-snug text-muted-foreground">{t("dialog.authBox.waiting")}</div>}
      <div className="font-content text-[12px] leading-snug text-foreground">
        {boxText.text.map((row, i) => (
          <div key={i} className="min-h-[1lh] whitespace-pre-wrap break-words">
            {row.map((run, j) =>
              run.kind === "link" ? (
                <a key={j} href={run.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
                  {run.text}
                </a>
              ) : (
                run.text
              ),
            )}
          </div>
        ))}
      </div>
    </PromptPanel>
  );
}
