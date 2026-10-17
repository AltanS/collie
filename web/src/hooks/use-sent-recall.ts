import { useRef } from "react";
import type { KeyboardEvent } from "react";

import { getSent } from "@/lib/api";
import type { Scope } from "@/lib/scope";
import { EMPTY_DRAFT, recallLines, recallText, stepRecall } from "@/lib/sent-recall";
import { SENT_PAGE } from "@/hooks/use-sent-list";

// ARROW-KEY RECALL IN THE COMPOSER OF A SHELL PANE (M61 spec 02), the way a shell's own history
// works. ArrowUp in an EMPTY box puts back the newest line sent from this folder, and each further
// press goes one older: this folder's lines first, then the rest of this machine's. ArrowDown goes
// back toward the empty box, and Escape drops the recalled line and leaves the box empty.
//
// WHEN IT STEPS ASIDE. ArrowUp is recall only while the box is empty or shows a line this hook put
// there. In a draft the arrow keys are the caret's. With a modifier held, during an IME composition
// and in "Type into terminal" (`enabled` false) the key is left alone.
//
// The lines are read when a walk begins, never kept between walks, so a line sent a moment ago is
// the first one back. They live in this hook's refs: no storage. The caller writes the recalled
// text into the box WITHOUT saving it as a draft, so a walk that stops halfway leaves no draft behind.

export interface UseSentRecallArgs {
  /** A shell pane whose box takes typing from the phone's keyboard. */
  enabled: boolean;
  scope: Scope | undefined;
  /** The pane's folder; absent, the walk is the machine's lines alone. */
  cwd: string | undefined;
  /** The box's text right now. */
  read: () => string;
  /** Put text in the box with the caret at its end, as a preview and not as a draft. */
  write: (text: string) => void;
}

export interface UseSentRecall {
  /**
   * The textarea's key handler. `canStart` is whether the box is empty with no attachment chip in it:
   * only then does ArrowUp begin a walk.
   */
  onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>, canStart: boolean) => void;
  /** The person edited the box: whatever was recalled is theirs now, and the walk is over. */
  stop: () => void;
}

export function useSentRecall({ enabled, scope, cwd, read, write }: UseSentRecallArgs): UseSentRecall {
  const lines = useRef<string[] | null>(null);
  const position = useRef(EMPTY_DRAFT);
  /** What the hook last wrote, to tell its own text from a person's edit. */
  const shown = useRef("");
  /** A walk's first read is on its way; a second ArrowUp in the meantime must not start another. */
  const reading = useRef(false);
  const host = scope?.host;

  function end() {
    lines.current = null;
    position.current = EMPTY_DRAFT;
    shown.current = "";
  }

  async function begin() {
    if (reading.current) return;
    reading.current = true;
    try {
      const where = host === undefined ? undefined : { host };
      const [folder, machine] = await Promise.all([
        cwd === undefined ? Promise.resolve(null) : getSent({ scope: "here", cwd, limit: SENT_PAGE }, where),
        getSent({ scope: "here", limit: SENT_PAGE }, where),
      ]);
      // The person typed while the read was out: the box is theirs.
      if (read() !== "") return;
      const found = recallLines(folder?.entries ?? [], machine.entries);
      if (found.length === 0) return;
      lines.current = found;
      position.current = stepRecall(EMPTY_DRAFT, "ArrowUp", found.length);
      shown.current = recallText(found, position.current);
      write(shown.current);
    } catch {
      // A bridge that cannot answer (or is older than Sent) leaves the box as it was.
    } finally {
      reading.current = false;
    }
  }

  function step(key: "ArrowUp" | "ArrowDown") {
    const found = lines.current;
    if (found === null) return;
    position.current = stepRecall(position.current, key, found.length);
    shown.current = recallText(found, position.current);
    write(shown.current);
    if (position.current === EMPTY_DRAFT) end();
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>, canStart: boolean) {
    if (!enabled || event.nativeEvent.isComposing) return;
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    // A walk is on only while the box still shows the line it put there.
    const walking = lines.current !== null && read() === shown.current;
    if (!walking && lines.current !== null) end();
    if (event.key === "ArrowUp") {
      if (!walking && !canStart) return;
      event.preventDefault();
      if (walking) step("ArrowUp");
      else void begin();
      return;
    }
    if (!walking) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      step("ArrowDown");
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      end();
      write("");
    }
  }

  return { onKeyDown, stop: end };
}
