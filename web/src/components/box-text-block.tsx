import type { BoxTextModel } from "@/lib/blocks";
import { OptionGroupCaption, PromptPanel } from "@/components/option-button";
import { buttonVariants } from "@/components/ui/button";
import { CopyableBlock } from "@/components/ui/copyable-block";
import { t } from "@/lib/i18n";
import { signInAddress, type SignInAddress } from "@/lib/sign-in-address";
import { cn } from "@/lib/utils";
import { useLocale } from "@/hooks/use-locale";

export interface BoxTextBlockProps {
  /** The titled box the grammar read off the pane: its title and its rows, links already found. */
  boxText: BoxTextModel;
  /**
   * The box is a sign-in card (the screen holds a sign-in field) and these are the hosts the agent's
   * adapter lists for its sign-in address (Change login, M101). The address then opens through one
   * primary button when it passes lib/sign-in-address.ts, and is text to copy when it does not. Absent:
   * the card is drawn as before, its links live.
   */
  signInHosts?: readonly string[];
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
//
// A SIGN-IN CARD (`signInHosts` given) has one way to open its address: the primary "Open sign-in page"
// button, a plain link with `rel="noopener noreferrer"`, whose href is the address only after the pure
// check in lib/sign-in-address.ts passed (https, a host the adapter lists, no credentials, no port, a
// length cap). In the rows the address is then plain text. An address that fails the check moves out
// of the rows into a copy block under them, with one line saying so. The address is drawn and linked, never kept.
export function BoxTextBlock({ boxText, signInHosts }: BoxTextBlockProps) {
  useLocale();
  const address = signInHosts === undefined ? null : signInAddress(boxText, signInHosts);
  return (
    <PromptPanel ariaLabel={t("dialog.authBox.label")}>
      <OptionGroupCaption>{boxText.title}</OptionGroupCaption>
      {boxText.phase === "waiting" && <div className="text-[12px] leading-snug text-muted-foreground">{t("dialog.authBox.waiting")}</div>}
      <div className="font-content text-[12px] leading-snug text-foreground">
        {boxText.text.map((row, i) => (
          <div key={i} className="min-h-[1lh] whitespace-pre-wrap break-words">
            {row.map((run, j) =>
              run.kind === "link" && address === null ? (
                <a key={j} href={run.href} target="_blank" rel="noopener noreferrer" className={LINK_CLASS}>
                  {run.text}
                </a>
              ) : run.kind === "link" && address?.kind === "copy" && run.text === address.text ? null : run.kind === "link" ? (
                // Shown once: in the copy block under the rows when it is text to copy.
                <span key={j} className="break-all">
                  {run.text}
                </span>
              ) : (
                run.text
              ),
            )}
          </div>
        ))}
      </div>
      {address !== null && <SignInAddressAction address={address} />}
    </PromptPanel>
  );
}

/** The sign-in card's one action: open the checked address, or copy one that did not pass. */
function SignInAddressAction({ address }: { address: SignInAddress }) {
  if (address.kind === "open") {
    return (
      <a data-slot="sign-in-open" href={address.href} target="_blank" rel="noopener noreferrer" className={cn(buttonVariants(), "h-11 w-full")}>
        {t("accounts.signInPage.open")}
      </a>
    );
  }
  return (
    <div data-slot="sign-in-copy" className="flex flex-col gap-1">
      <p className="text-[12px] leading-snug text-muted-foreground">{t("accounts.signInPage.copy")}</p>
      <CopyableBlock text={address.text}>
        <p className="break-all rounded-md bg-muted py-2 pl-2 pr-10 font-mono text-xs leading-5">{address.text}</p>
      </CopyableBlock>
    </div>
  );
}
