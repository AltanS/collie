import { Icon } from "@/components/icons/icon";
import { useRef, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useCopyFeedback } from "@/hooks/use-copy-feedback";
import { useLocale } from "@/hooks/use-locale";
import { canCopyText, copyText } from "@/lib/clipboard";
import { flashCopied } from "@/lib/copied-flash";
import { t } from "@/lib/i18n";
import { setStatus } from "@/lib/status";
import { cn } from "@/lib/utils";

interface CopyableBlockProps {
  text: string;
  children: ReactNode;
  label?: string;
  className?: string;
}

export function CopyableBlock({ text, children, label, className }: CopyableBlockProps): ReactNode {
  useLocale();
  const canCopy = canCopyText();
  // The icon is the one place every screen shows the outcome: History and Files have no status line.
  const [state, show] = useCopyFeedback();
  // The block itself flashes on a copy that worked (lib/copied-flash.ts), not the button.
  const root = useRef<HTMLDivElement>(null);
  const copyLabel =
    state === "done" ? t("copyable.done") : state === "failed" ? t("copyable.failed") : (label ?? t("copyable.copy"));
  const copy = async () => {
    try {
      await copyText(text);
      flashCopied(root.current);
      show("done");
      setStatus(t("copyable.done"), "success");
    } catch {
      show("failed");
      setStatus(t("copyable.failed"), "error");
    }
  };
  return (
    <div ref={root} className={cn("relative min-w-0", className)}>
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
            <Icon name="copied" aria-hidden className="size-3.5 text-status-working" />
          ) : state === "failed" ? (
            <Icon name="copy-failed" aria-hidden className="size-3.5 text-status-blocked" />
          ) : (
            <Icon name="copy" aria-hidden className="size-3.5" />
          )}
        </Button>
      )}
      {children}
    </div>
  );
}
