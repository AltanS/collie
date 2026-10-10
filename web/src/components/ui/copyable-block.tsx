import { Check, Copy, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
import { canCopyText, copyText } from "@/lib/clipboard";
import { t } from "@/lib/i18n";
import { setStatus } from "@/lib/status";
import { cn } from "@/lib/utils";

interface CopyableBlockProps {
  text: string;
  children: ReactNode;
  label?: string;
  className?: string;
}

/** How long the icon shows the outcome of a copy before it returns to the copy glyph. */
const FEEDBACK_MS = 1500;

type CopyState = "idle" | "done" | "failed";

export function CopyableBlock({ text, children, label, className }: CopyableBlockProps): ReactNode {
  useLocale();
  const canCopy = canCopyText();
  const [state, setState] = useState<CopyState>("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  // The icon is the one place every screen shows the outcome: History and Files have no status line.
  const show = (next: CopyState) => {
    window.clearTimeout(timer.current);
    setState(next);
    timer.current = window.setTimeout(() => setState("idle"), FEEDBACK_MS);
  };
  const copyLabel =
    state === "done" ? t("copyable.done") : state === "failed" ? t("copyable.failed") : (label ?? t("copyable.copy"));
  const copy = async () => {
    try {
      await copyText(text);
      show("done");
      setStatus(t("copyable.done"), "success");
    } catch {
      show("failed");
      setStatus(t("copyable.failed"), "error");
    }
  };
  return (
    <div className={cn("relative min-w-0", className)}>
      {canCopy && (
        <Button
          type="button"
          variant="outline"
          size="icon"
          aria-label={copyLabel}
          title={copyLabel}
          // The opaque overlay deliberately covers text; its 44px reach may overflow without reserving space.
          className="absolute top-0.5 right-0.5 z-[1] size-6 bg-card text-card-foreground before:absolute before:-inset-[11px] before:content-['']"
          onClick={() => void copy()}
        >
          {state === "done" ? (
            <Check aria-hidden className="size-3.5 text-status-working" />
          ) : state === "failed" ? (
            <X aria-hidden className="size-3.5 text-status-blocked" />
          ) : (
            <Copy aria-hidden className="size-3.5" />
          )}
        </Button>
      )}
      {children}
    </div>
  );
}
