import { Fragment } from "react";

import { CHIP_BOX, CHIP_TONE } from "@/components/walky-id-chip";
import { useWalkyPanes, useWalkySelf } from "@/components/walky-log";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import type { AgentView } from "@/lib/types";
import { cn } from "@/lib/utils";
import { splitWalkyAddresses } from "@/lib/walky-names";

// A session named in running text (M80 spec 12). An agent's message often says where to look
// ("see bluefin/w54:p1J"); the address is the wire's, the person reads the session's name. The address
// in the text is a CLAIM, so a name is drawn only where a live pane holds it (lib/walky-names.ts) and
// everything else stays the text it was. The name is a React text node, never markup: the same XSS
// boundary every pane name keeps.
//
// Only an address that names ONE session for certain (written with its instance token, and that instance is
// live) is a chip. A bare pane id, or an address written without its token, names whatever holds the id now,
// so it keeps the agent's words and gets the name after them in brackets: `w54:p1J (tests on bluefin)`.
//
// The chip is a button that opens that pane, the way the pane switcher does. It is never a link: it
// opens a pane over this one with the slide, it names no URL. It keeps the 44px hit reach of the id chip.
// Inside a control (the Chat card is one button when it opens the Messages sheet) a nested button would
// be invalid and would steal the card's tap, so there it draws the same name as plain, quiet text.

/** The words a chip or a head says for a session: "name", or "name on machine" when it is another machine's. */
export function nameOnMachine(name: string, machine: string | null): string {
  return machine === null ? name : t("walky.name.onMachine", { name, machine });
}

/** One session's name as a chip that opens its pane, or as plain marked text when `onOpen` is null. */
export function WalkyNameChip({
  pane,
  name,
  machine,
  onOpen,
}: {
  pane: AgentView;
  name: string;
  machine: string | null;
  onOpen: ((pane: AgentView) => void) | null;
}) {
  useLocale();
  const words = nameOnMachine(name, machine);
  if (onOpen === null) {
    return (
      <span data-slot="walky-name" className="font-medium">
        {words}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-slot="walky-name-chip"
      aria-label={t("walky.name.aria", { name: words })}
      onClick={() => onOpen(pane)}
      className={cn(CHIP_BOX, CHIP_TONE, "max-w-full whitespace-normal break-words text-left font-medium")}
    >
      {words}
    </button>
  );
}

/**
 * A message body with each address that names a live pane drawn as that pane's name. With no panes
 * known, or no address that resolves, this is the text as it came. `interactive` false draws the name
 * without a button (see the note above). `self` is this pane's address when the caller has it as a prop.
 */
export function WalkyBodyText({ text, interactive = true, self: selfOverride }: { text: string; interactive?: boolean; self?: string | undefined }) {
  const panes = useWalkyPanes();
  const ctxSelf = useWalkySelf();
  // The Messages sheet sits outside the pane's open provider and is handed its address as a prop.
  const self = selfOverride ?? ctxSelf;
  if (panes === null) return <>{text}</>;
  // The cheap test first: every address that can resolve holds one of these.
  if (!(text.includes("/") || text.includes(":") || text.includes("%") || text.includes("_"))) return <>{text}</>;
  const parts = splitWalkyAddresses(text, panes.live, self);
  if (parts.length === 1 && parts[0]?.kind === "text") return <>{text}</>;
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part.kind === "text" ? (
            part.text
          ) : part.pinned ? (
            <WalkyNameChip pane={part.pane} name={part.name} machine={part.machine} onOpen={interactive ? panes.open : null} />
          ) : (
            // Not pinned to one session: the agent's text stays as written, the name follows as plain text, never a button.
            `${part.address} (${nameOnMachine(part.name, part.machine)})`
          )}
        </Fragment>
      ))}
    </>
  );
}
