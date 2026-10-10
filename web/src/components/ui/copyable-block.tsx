import { Copy } from "lucide-react";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { useLocale } from "@/hooks/use-locale";
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
  const canCopy = !!navigator.clipboard;
  const copyLabel = label ?? t("copyable.copy");
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setStatus(t("copyable.done"), "success");
    } catch {
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
          <Copy aria-hidden className="size-3.5" />
        </Button>
      )}
      {children}
    </div>
  );
}
