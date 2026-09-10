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
