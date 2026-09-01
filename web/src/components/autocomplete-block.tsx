import type { AutocompleteModel } from "@/lib/blocks";
import { OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";

export interface AutocompleteBlockProps {
  /** The completion popup the grammar read off the pane: the candidates, in the order printed. */
  autocomplete: AutocompleteModel;
}

// The agent's own completion popup, rendered as a list instead of mirrored as terminal text.
//
// It is the ONE block in this family with no controls, and that is the design, not an omission. The
// popup is not a modal: the input box is live underneath it, so the composer is enabled, and the way
// out of the popup is the way the operator got in — keep typing, or dismiss it. Dismissing already
// has a home: the pane's key tray (components/nav-tray.tsx) publishes Esc alongside the other bare
// keys, and it works here because nothing about this screen is race-sensitive. Duplicating that as a
// per-block button would put a second Esc on the same screen for no new capability.
//
// Why lift it at all, then: Claude lays the popup out for the terminal's full width (220 columns in
// the capture this was written against), so on a phone the mirror soft-wrapped 23 rows into an
// unreadable ribbon in which the completion names were no longer in a column. A list of name +
// description reads at phone width; the description is CLAMPED TO TWO LINES because a skill blurb can
// run to several hundred characters and the point of the list is to scan the names.
//
// Text is React text nodes only. Unlike menu-block.tsx this one does NOT keep the terminal region
// visible, so the mirror's dark colour space (MIRROR_SPACE, .adr/0002) never enters: the grammar
// parsed the whole popup, there is nothing left that only the raw text could say. That also drops the
// popup's own colours, which is correct here — the highlight they carry is the terminal's cursor
// position, and it moves under the OPERATOR's keyboard on the host, not under anything this app sends.
export function AutocompleteBlock({ autocomplete }: AutocompleteBlockProps) {
  useLocale();
  return (
    <PromptPanel ariaLabel={t("dialog.autocomplete.title")}>
      <OptionGroupCaption>{t("dialog.autocomplete.title")}</OptionGroupCaption>
      <ul className="flex flex-col gap-1">
        {autocomplete.entries.map((entry, i) => (
          <li
            key={i}
            className="flex flex-col gap-0.5 rounded-lg border border-border bg-secondary/50 px-2 py-1.5"
          >
            <span className="font-mono text-[12px] font-medium text-foreground">{entry.name}</span>
            {entry.description !== "" && (
              <span className="font-content line-clamp-2 text-[11px] leading-snug text-muted-foreground">
                {entry.description}
              </span>
            )}
          </li>
        ))}
      </ul>
    </PromptPanel>
  );
}
