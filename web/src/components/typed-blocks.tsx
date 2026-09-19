import { useLayoutEffect, useRef } from "react";
import type {
  Block,
  MenuModel,
  MultiSelectModel,
  PreviewSelectModel,
  PromptModel,
  WizardModel,
} from "@/lib/blocks";
import { PromptSelectBlock, type PromptBlockAction } from "@/components/prompt-select-block";
import { WizardBlock } from "@/components/wizard-block";
import { PreviewSelectBlock, type PreviewBlockAction } from "@/components/preview-select-block";
import { MultiSelectBlock } from "@/components/multi-select-block";
import { MenuBlock, type MenuBlockAction } from "@/components/menu-block";
import { AutocompleteBlock } from "@/components/autocomplete-block";
import type { MultiSelectIntent } from "@/lib/multi-select-action";
import { lineText } from "@/lib/blocks";
import { QuestionHeading } from "@/components/option-button";

// The reusable typed-block seam: the presentation half of AnsiOutput's non-raw tail block, extracted
// so a view that does NOT render raw terminal rows (Conversation mode) can still show the supported
// prompt controls. Behavior-preserving by construction — the block finding and the rendering chain
// below are the exact code AnsiOutput ran, moved verbatim — and it stays presentational only: every
// action handler is injected, and the guards (fresh pane rederivation, dialog-guard, prompt binding)
// remain with the callers. Nothing here decides WHAT may be sent.
//
// The precedence chain and its tail-only, mutually-exclusive shape are pinned by lib/harness
// (buildBlocks emits at most one non-raw tail block) and by ansi-output.test.tsx; a Conversation view
// consumes the same Block[] buildBlocks produced for the mirror, so no grammar is duplicated.

export interface TypedBlocksProps {
  /** The full Block[] the pane's grammar produced (raw included — the raw blocks are ignored here). */
  blocks: readonly Block[];
  /** Injected handler for a prompt-select tap (the race guard lives in AgentChat). Absent (or with a
   *  disabled block) means the buttons render but don't act — this component never touches the network. */
  onPromptAction?: (
    action: PromptBlockAction,
    prompt: PromptModel,
  ) => boolean | void | Promise<boolean | void>;
  /** Injected handler for a wizard tap — one race-guarded keystroke per control (see
   *  lib/wizard-action.ts). Same presentational contract as onPromptAction. */
  onWizardAction?: (keys: string[], wizard: WizardModel) => void | Promise<void>;
  /** Injected handler for a preview-dialog tap (option / note / step-nav intents — the race-guarded
   *  choreography lives in lib/preview-action.ts). Same presentational contract as onPromptAction. */
  onPreviewAction?: (action: PreviewBlockAction, preview: PreviewSelectModel) => void | Promise<void>;
  /** Injected handler for a multi-select tap (toggle / submit / escape / confirm / cancel — the
   *  race-guarded choreography lives in lib/multi-select-action.ts). Same presentational contract. */
  onMultiSelectAction?: (action: MultiSelectIntent, multi: MultiSelectModel) => void | Promise<void>;
  /** Injected handler for a generic-menu tap (a footer-named key, or an arrow — the race-guarded
   *  send lives in lib/menu-action.ts). Same presentational contract as onPromptAction. */
  onMenuAction?: (action: MenuBlockAction, menu: MenuModel) => void | Promise<void>;
  /** Disable the prompt-select/wizard/preview/multi-select/menu buttons (read-only / gone pane). */
  promptDisabled?: boolean;
}

/** These controls rely on the raw mirror for their question and action details in Terminal. */
function contextQuestion(blocks: readonly Block[]): string | undefined {
  const block = blocks.find((candidate) => candidate.kind !== "raw");
  if (block?.kind === "prompt-select") return block.prompt.question;
  if (block?.kind === "preview-select" && block.preview.steps === null) return block.preview.question;
  return undefined;
}

function rawContext(blocks: readonly Block[]): string {
  return blocks.flatMap((block) => block.kind === "raw" ? block.lines.map(lineText) : []).join("\n");
}

/** Presentation eligibility only. Keyboard ownership and action authorization remain independent. */
export function canRenderInline(blocks: readonly Block[]): boolean {
  if (!blocks.some((block) => block.kind !== "raw")) return false;
  const question = contextQuestion(blocks);
  if (question === undefined) return true;
  // These renderers expect the current question in the raw preamble. An adapter that places it
  // elsewhere may also have lifted action details we cannot display here. Use Terminal instead
  // of treating unrelated raw output as approval context. Normalize wrapping, not grammar.
  const visibleQuestion = question.replace(/\s+/g, " ").trim();
  return visibleQuestion.length > 0 && rawContext(blocks).replace(/\s+/g, " ").includes(visibleQuestion);
}

/** Add the context Terminal normally supplies, without changing its controls or their callbacks. */
export function InlineTypedBlocks(props: TypedBlocksProps) {
  const contextRef = useRef<HTMLPreElement>(null);
  const question = contextQuestion(props.blocks);
  // Keep ALL captured raw context. A row cap could drop the command, filename or beginning of a
  // proposed edit. The AST has no semantic start-of-action boundary; do not invent one here.
  const context = rawContext(props.blocks);
  // Start at the current action beside the question, not old output at the pane's head. Earlier
  // rows remain scrollable, and an unrelated render must not reset the reader's position.
  useLayoutEffect(() => {
    const node = contextRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [context]);
  if (!canRenderInline(props.blocks)) return null;
  return (
    <>
      {question !== undefined && (
        <div data-slot="conversation-inline-context" className="min-w-0 max-w-full">
          <pre ref={contextRef} className="mb-2 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground focus-visible:outline-2 outline-offset-2 outline-ring">{context}</pre>
          <QuestionHeading>{question}</QuestionHeading>
        </div>
      )}
      <TypedBlocks {...props} />
    </>
  );
}

export function TypedBlocks({
  blocks,
  onPromptAction,
  onWizardAction,
  onPreviewAction,
  onMultiSelectAction,
  onMenuAction,
  promptDisabled,
}: TypedBlocksProps) {
  const promptBlock = blocks.find((b): b is Extract<Block, { kind: "prompt-select" }> => b.kind === "prompt-select") ?? null;
  const wizardBlock = blocks.find((b): b is Extract<Block, { kind: "wizard" }> => b.kind === "wizard") ?? null;
  const previewBlock = blocks.find((b): b is Extract<Block, { kind: "preview-select" }> => b.kind === "preview-select") ?? null;
  const multiBlock = blocks.find((b): b is Extract<Block, { kind: "multi-select" }> => b.kind === "multi-select") ?? null;
  const menuBlock = blocks.find((b): b is Extract<Block, { kind: "menu" }> => b.kind === "menu") ?? null;
  const autoBlock = blocks.find((b): b is Extract<Block, { kind: "autocomplete" }> => b.kind === "autocomplete") ?? null;

  if (promptBlock) {
    return (
      <PromptSelectBlock
        prompt={promptBlock.prompt}
        disabled={promptDisabled || !onPromptAction}
        onAction={(action) => onPromptAction?.(action, promptBlock.prompt) ?? false}
      />
    );
  }
  if (wizardBlock) {
    return (
      <WizardBlock
        wizard={wizardBlock.wizard}
        disabled={promptDisabled || !onWizardAction}
        onAction={(keys) => onWizardAction?.(keys, wizardBlock.wizard)}
      />
    );
  }
  if (previewBlock) {
    return (
      <PreviewSelectBlock
        preview={previewBlock.preview}
        disabled={promptDisabled || !onPreviewAction}
        onAction={(action) => onPreviewAction?.(action, previewBlock.preview)}
      />
    );
  }
  if (multiBlock) {
    return (
      <MultiSelectBlock
        multi={multiBlock.multi}
        disabled={promptDisabled || !onMultiSelectAction}
        onAction={(action) => onMultiSelectAction?.(action, multiBlock.multi)}
      />
    );
  }
  if (menuBlock) {
    return (
      <MenuBlock
        menu={menuBlock.menu}
        lines={menuBlock.lines}
        disabled={promptDisabled || !onMenuAction}
        onAction={(action) => onMenuAction?.(action, menuBlock.menu)}
      />
    );
  }
  if (autoBlock) {
    // No handler and no `disabled`: the completion popup emits no keystroke, so there is nothing for
    // a read-only device to be refused. It is last in the chain only because it is the least
    // specific tail shape; the grammars above are mutually exclusive with it anyway (a popup means an
    // input box, and every dialog above means there isn't one).
    return <AutocompleteBlock autocomplete={autoBlock.autocomplete} />;
  }
  return null;
}
