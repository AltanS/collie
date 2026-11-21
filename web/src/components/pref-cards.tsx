import { useState } from "react";

import { Icon } from "@/components/icons/icon";
import type { IconKey } from "@/components/icons/keys";
import { KeyBoardEditor } from "@/components/key-board-editor";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { useDashPrefs } from "@/hooks/use-dash-prefs";
import { CHAT_FONT_MAX, CHAT_FONT_MIN, useDisplayPrefs } from "@/hooks/use-display-prefs";
import { useLocale } from "@/hooks/use-locale";
import { t, type MessageKey } from "@/lib/i18n";
import { useMuxUnsupportedKeys } from "@/lib/mux-capability";
import { PANE_VIEWS, type PaneView } from "@/lib/pane-view";
import { cn } from "@/lib/utils";

// THE SETTINGS CARDS OF VALUES THAT HAD NO SETTINGS ROW (ADR 0170). Each of these was set only in a pane's own
// Display sheet or in the Keys pad's tray, so a person who looked in Settings did not find it. The card writes the
// SAME value through the SAME hook the sheet uses, so the two places never disagree; the sheet keeps its rows,
// because a pane's own sheet is the one second place a value may have.
//
// The look is the one every single-value card in Settings has (ToolCallsControl, ZoomPillControl): an icon, the
// name and its sentence, the control at the end or in a band under a divider.

function SwitchCard({
  icon,
  label,
  hint,
  checked,
  onChange,
}: {
  icon: IconKey;
  label: MessageKey;
  hint: MessageKey;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name={icon} className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t(label)}</div>
            <p className="text-sm text-muted-foreground">{t(hint)}</p>
          </div>
        </div>
        <Switch checked={checked} onCheckedChange={onChange} aria-label={t(label)} />
      </div>
    </Card>
  );
}

/** For replies written with the cc-stretch plugin: the short form first. Both views draw such replies. */
export function ShortFormControl() {
  useLocale();
  const { prefs, setStretchText } = useDisplayPrefs();
  return (
    <SwitchCard icon="message-agent" label="settings.display.shortForm.label" hint="settings.display.shortForm.hint" checked={prefs.stretchText} onChange={setStretchText} />
  );
}

/** Whether the terminal mirror wraps its long lines. */
export function WrapControl() {
  useLocale();
  const { prefs, setWrap } = useDisplayPrefs();
  return <SwitchCard icon="view-terminal" label="settings.display.wrap.label" hint="settings.display.wrap.hint" checked={prefs.wrap} onChange={setWrap} />;
}

/** Whether the terminal opens the agent's last reply whole when the screen clips it. */
export function WholeReplyControl() {
  useLocale();
  const { prefs, setExpandClippedReply } = useDisplayPrefs();
  return (
    <SwitchCard
      icon="expand"
      label="settings.display.wholeReply.label"
      hint="settings.display.fullReply.hint"
      checked={prefs.expandClippedReply}
      onChange={setExpandClippedReply}
    />
  );
}

/** The terminal as the multiplexer draws it, with none of Collie's own reading. */
export function RawTerminalControl() {
  useLocale();
  const { prefs, setRawTerminal } = useDisplayPrefs();
  return (
    <SwitchCard icon="show-terminal-view" label="settings.display.rawTerminal.label" hint="settings.display.rawTerminal.hint" checked={prefs.rawTerminal} onChange={setRawTerminal} />
  );
}

/** Whether a tap on the terminal puts the cursor in the reply box. */
export function TapToTypeControl() {
  useLocale();
  const { prefs, setTapToFocus } = useDisplayPrefs();
  return (
    <SwitchCard icon="type-into-terminal" label="settings.display.tapToType.label" hint="settings.display.tapToType.hint" checked={prefs.tapToFocus} onChange={setTapToFocus} />
  );
}

const VIEW_LABEL = {
  terminal: "chat.mode.option.terminal",
  chat: "chat.mode.option.chat",
} as const satisfies Record<PaneView, MessageKey>;

/**
 * Which body a pane opens in: Chat or the terminal. The same standing choice the pane's Display sheet and its ⋮
 * menu write; a pane with no session log still draws its terminal, as it does whatever is picked here.
 */
export function PaneViewSettingControl() {
  useLocale();
  const { prefs, setPaneView } = useDashPrefs();
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center gap-3 p-4">
        <Icon name="view-chat" className="size-5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 font-medium">{t("chat.mode.view.label")}</div>
      </div>
      <div role="radiogroup" aria-label={t("chat.mode.view.label")} className="flex gap-1 border-t border-border p-2">
        {PANE_VIEWS.map((view) => {
          const selected = view === prefs.paneView;
          return (
            <button
              key={view}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setPaneView(view)}
              className={cn(
                "flex min-h-11 flex-1 items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors",
                selected ? "bg-primary text-primary-foreground" : "text-muted-foreground active:bg-muted",
              )}
            >
              {t(VIEW_LABEL[view])}
            </button>
          );
        })}
      </div>
    </Card>
  );
}

/** The Chat view's own text size: its own number, never the terminal's (the Display sheet steps the same one). */
export function ChatTextSizeControl() {
  useLocale();
  const { prefs, stepChatFontSize } = useDisplayPrefs();
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-center gap-3">
          <Icon name="view-chat" className="size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0 font-medium">{t("settings.textSize.chat")}</div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            className="size-11"
            disabled={prefs.chatFontSize <= CHAT_FONT_MIN}
            onClick={() => stepChatFontSize(-1)}
            aria-label={t("settings.display.textSize.decrease")}
          >
            <Icon name="text-smaller" className="size-4" />
          </Button>
          {/* Fixed width and tabular figures, so the number cannot resize its slot as it steps. */}
          <span className="w-8 text-center text-xs tabular-nums text-muted-foreground">{prefs.chatFontSize}</span>
          <Button
            variant="outline"
            size="icon"
            className="size-11"
            disabled={prefs.chatFontSize >= CHAT_FONT_MAX}
            onClick={() => stepChatFontSize(1)}
            aria-label={t("settings.display.textSize.increase")}
          >
            <Icon name="text-larger" className="size-4" />
          </Button>
        </div>
      </div>
    </Card>
  );
}

/**
 * The Keys pad's editor, from Settings: the same editor the pad's tray opens (components/key-board-editor.tsx),
 * with its presets and Copy layout inside. The chords the multiplexer refuses come from the bridge's mux config,
 * as they do for the pad.
 */
export function KeysPadControl() {
  useLocale();
  const [open, setOpen] = useState(false);
  const unsupportedKeys = useMuxUnsupportedKeys();
  return (
    <Card className="gap-0 py-0">
      <div className="flex items-center justify-between gap-4 p-4">
        <div className="flex min-w-0 items-start gap-3">
          <Icon name="keys-drawer" className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
          <div className="min-w-0">
            <div className="font-medium">{t("keys.editor.title")}</div>
            <p className="text-sm text-muted-foreground">{t("keys.editor.intro")}</p>
          </div>
        </div>
        <Button variant="outline" className="min-h-11 shrink-0" onClick={() => setOpen(true)}>
          {t("keys.editor.title")}
        </Button>
      </div>
      <KeyBoardEditor open={open} onClose={() => setOpen(false)} unsupportedKeys={unsupportedKeys} />
    </Card>
  );
}
