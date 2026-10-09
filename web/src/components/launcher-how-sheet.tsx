import { Check, Copy } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { OneOf } from "@/components/ui/one-of";
import { BottomSheet } from "@/components/ui/sheet";
import { useLocale } from "@/hooks/use-locale";
import { t } from "@/lib/i18n";
import { EXAMPLE_ROW } from "@/lib/launcher-add";
import { NEW_PAGE_DOCS } from "@/lib/new-page";

/**
 * "How adding works": the explainer behind the add page's link (ADR 0094, spec 02 item 10). One
 * sheet, four short parts: what a recipe is, what "Write a command" is and how the operator turns it
 * on, where the operator's own rows live (this machine's `launchers.toml`, with one example row to
 * copy), and where the rows a phone adds live. It ends on the docs link the New page carries.
 *
 * `file` is the machine's own path, as the bridge reports it, so the sentence is true for the machine
 * the person is adding to. The example code is text in a read-only box: Copy writes it to the
 * clipboard, and a page on plain http (no clipboard) selects it instead, as the Keys code does.
 */
export function LauncherHowSheet({ open, onClose, file }: { open: boolean; onClose: () => void; file: string | undefined }) {
  useLocale();
  const box = useRef<HTMLTextAreaElement>(null);
  const [copied, setCopied] = useState<"idle" | "done" | "byHand">("idle");

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(EXAMPLE_ROW);
      setCopied("done");
    } catch {
      // No clipboard (plain http) or it refused: select the text so a long press can copy it.
      box.current?.focus({ preventScroll: true });
      box.current?.select();
      setCopied("byHand");
    }
  };

  return (
    <BottomSheet
      open={open}
      onClose={() => {
        setCopied("idle");
        onClose();
      }}
      title={t("launcherAdd.how.title")}
    >
      <div className="flex flex-col gap-4 text-sm">
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">{t("launcherAdd.way.recipe")}</h3>
          <p className="text-muted-foreground">{t("launcherAdd.how.recipe.body")}</p>
        </section>
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">{t("launcherAdd.mode.text")}</h3>
          <p className="text-muted-foreground">{t("launcherAdd.how.text.body")}</p>
          <code className="w-fit rounded-sm border border-border bg-background px-2 py-1 font-mono text-xs">free_text = true</code>
        </section>
        <section className="flex flex-col gap-2">
          <h3 className="font-semibold">{t("launcherAdd.how.file.title")}</h3>
          <p className="text-muted-foreground">{t("launcherAdd.how.file.body")}</p>
          {file !== undefined && (
            <p data-testid="launcher-file" className="break-all font-mono text-xs">
              {file}
            </p>
          )}
          <textarea
            ref={box}
            readOnly
            rows={EXAMPLE_ROW.split("\n").length}
            aria-label={t("launcherAdd.how.exampleAria")}
            value={EXAMPLE_ROW}
            onFocus={(e) => e.currentTarget.select()}
            className="w-full resize-none rounded-sm border border-border bg-background px-3 py-2 font-mono text-xs focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          />
          <Button type="button" variant="outline" className="h-11 w-full gap-2" onClick={() => void copy()}>
            {copied === "done" ? <Check className="size-4" aria-hidden="true" /> : <Copy className="size-4" aria-hidden="true" />}
            <OneOf
              active={copied === "done" ? "done" : "idle"}
              className="justify-items-center"
              options={[
                { key: "idle", node: <span>{t("launcherAdd.how.copy")}</span> },
                { key: "done", node: <span>{t("launcherAdd.how.copied")}</span> },
              ]}
            />
          </Button>
          <p className="min-h-5 text-xs text-muted-foreground" aria-live="polite">
            {copied === "byHand" ? t("launcherAdd.how.copyByHand") : ""}
          </p>
        </section>
        <section className="flex flex-col gap-1">
          <h3 className="font-semibold">{t("launcherAdd.how.phone.title")}</h3>
          <p className="text-muted-foreground">{t("launcherAdd.how.phone.body")}</p>
        </section>
        <a
          href={NEW_PAGE_DOCS.agent}
          target="_blank"
          rel="noreferrer noopener"
          className="inline-flex min-h-11 w-fit items-center text-xs underline underline-offset-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
        >
          {t("newPage.agents.docs")}
        </a>
      </div>
    </BottomSheet>
  );
}
