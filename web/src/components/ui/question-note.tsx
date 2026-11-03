import { lazy, Suspense, useState } from "react";
import { Loader2, Pencil, StickyNote, Trash2 } from "lucide-react";
import type { PreviewNote } from "@/lib/harness/preview-model";
import type { SeenValue } from "@/lib/editor-action";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import { Button } from "./button";

interface QuestionNoteProps {
  note: PreviewNote;
  disabled?: boolean;
  saving: boolean;
  maxLength: number;
  /** Native editors and their complete seen values belong to the dock, not this summary. */
  onRead?: (remove?: boolean) => Promise<SeenValue | null>;
  onSave: (text: string) => boolean | void | Promise<boolean | void>;
}

// Keep the form off the boot chunk; drafts and seen context remain in its caller while it loads.
export const QuestionNoteEditor = lazy(() => import("./question-note-editor"));

/** Native edit requests delegate to the dock; legacy notes retain their local form. */
export function QuestionNote({ note, disabled, saving, maxLength, onRead, onSave }: QuestionNoteProps) {
  useLocale();
  const [editorOpen, setEditorOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [reading, setReading] = useState(false);
  const locked = disabled || saving || reading || (note.state === "editing" && !onRead) || (note.textComplete === false && !onRead);
  const busyIcon = <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label={t("dialog.sendingAria")} />;

  async function open(remove = false) {
    if (locked) return;
    if (onRead) {
      setReading(true);
      try { await onRead(remove); }
      finally { setReading(false); }
      return;
    }
    setDraft(note.text);
    setEditorOpen(true);
  }

  async function save() {
    const text = draft.trim();
    if (locked || text === "") return;
    if (await onSave(text) !== false) setEditorOpen(false);
  }

  if (note.state === "editing") {
    return (
      <div className="rounded-lg border border-dashed border-status-working/50 px-3 py-2 text-xs text-status-working">
        {t("dialog.preview.editingBanner")}
        {note.text ? <span className="font-content text-muted-foreground"> ({note.text})</span> : null}
      </div>
    );
  }
  if (editorOpen) {
    return <Suspense fallback={<span role="status">{t("conversations.loading")}</span>}><QuestionNoteEditor draft={draft} onChange={setDraft} disabled={locked} saving={saving}
      maxLength={maxLength} onSave={() => void save()} onCancel={() => setEditorOpen(false)} /></Suspense>;
  }
  if (note.state === "attached") {
    return (
      <div className="flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2">
        <StickyNote className="mt-0.5 size-3.5 shrink-0 text-primary" aria-label={t("dialog.preview.noteAria")} />
        <span className="font-content min-w-0 flex-1 text-xs text-foreground/90">{note.text}</span>
        <Button type="button" variant="ghost" size="icon" aria-label={t("dialog.preview.editNoteAria")} disabled={locked} onClick={() => void open()} className="min-h-11 min-w-11 text-muted-foreground">
          {reading ? busyIcon : <Pencil className="size-3.5" />}
        </Button>
        <Button type="button" variant="ghost" size="icon" aria-label={t("dialog.preview.removeNoteAria")} disabled={locked} onClick={() => onRead ? void open(true) : void onSave("")} className="min-h-11 min-w-11 text-muted-foreground">
          {saving ? busyIcon : <Trash2 className="size-3.5" />}
        </Button>
      </div>
    );
  }
  return (
    <Button type="button" variant="outline" disabled={locked} onClick={() => void open()} className="min-h-11 w-full justify-start border-dashed text-xs text-muted-foreground">
      {reading ? busyIcon : <StickyNote className="size-3.5 shrink-0" />}
      {t("dialog.preview.addNote")}
    </Button>
  );
}
