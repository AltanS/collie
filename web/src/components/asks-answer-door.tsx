import { useLocation } from "react-router";

import { useAsksDeck } from "@/hooks/use-asks-deck";
import { useNav } from "@/hooks/use-nav";
import { useShortcutHandler } from "@/hooks/use-shortcut-handler";
import { useAskDrafts } from "@/lib/hill/asks-drafts";
import { nextUpOf, requestAsksSend } from "@/lib/hill/asks-next";
import { askPath, hillPath } from "@/lib/nav";
import { useOptionalRootData } from "@/lib/route-data";
import { useScope } from "@/lib/session";

// THE ACTION `answer_next_ask` (Asks build 6, 2026-11-23), mounted once at the root, because it is offered on every screen
// while Asks is on and at least one ask is open. It does what the Next up card's button does, from the same answer
// (`nextUpOf`): it opens the first open ask that has no answer marked here, or, when only Send is left, the Send sheet of
// the first session with marks. The sheet belongs to the Asks page, so from another screen the action goes to the page
// and asks it to open the sheet (`requestAsksSend`). With Asks off, with no open ask, or on a bridge with no Hill, no
// handler is registered: the action is not offered, and Actions does not list it.

export function AsksAnswerDoor() {
  const root = useOptionalRootData();
  const nav = useNav();
  const scope = useScope();
  const { pathname } = useLocation();
  const { sessions } = useAsksDeck();
  const drafts = useAskDrafts();
  const on = root?.hill === true && root.hillOff !== true;
  const next = on ? nextUpOf(sessions, drafts) : null;
  const board = hillPath(scope).split("?")[0];
  useShortcutHandler(
    "answer_next_ask",
    next === null
      ? undefined
      : () => {
          if (next.kind === "ask") {
            // Inside the deck the entry is replaced, as Previous and Next do; from anywhere else the ask is one level down.
            if (pathname.startsWith("/asks/ask/")) nav.side(askPath(next.ask.id, scope));
            else nav.down(askPath(next.ask.id, scope));
            return;
          }
          requestAsksSend(next.session.key);
          if (pathname !== board) nav.down(hillPath(scope));
        },
  );
  return null;
}
