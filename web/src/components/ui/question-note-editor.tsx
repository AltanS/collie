import { useEffect, useRef } from "react";
import { Loader2, StickyNote } from "lucide-react";
import { t } from "@/lib/i18n";
import { useLocale } from "@/hooks/use-locale";
import { Button } from "./button";

interface QuestionNoteEditorProps {
  draft: string;
  onChange: (text: string) => void;
  disabled?: boolean;
  saving: boolean;
  returning?: boolean;
  maxLength: number;
  onSave: () => void;
  onCancel: () => void;
  allowEmpty?: boolean;
  readOnly?: boolean;
  inputDisabled?: boolean;
  saveLabel?: string;
  cancelLabel?: string;
  label?: string;
}

/** Stateless existing note form. Lazy UI code; its caller retains the draft and native context. */
export default function QuestionNoteEditor({ draft, onChange, disabled, saving, returning, maxLength, onSave, onCancel,
  allowEmpty, readOnly, inputDisabled, saveLabel, cancelLabel, label }: QuestionNoteEditorProps) {
  useLocale();
  const editorRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { editorRef.current?.focus(); }, []);
  const busyIcon = <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" aria-label={t("dialog.sendingAria")} />;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-muted/30 px-3 py-2">
      <label htmlFor="preview-note-text" className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        <StickyNote className="size-3.5 shrink-0" />
        {label ?? t("dialog.preview.noteForQuestion")}
      </label>
      <textarea
        id="preview-note-text"
        ref={editorRef}
        value={draft}
        onChange={(e) => onChange(e.target.value)}
        maxLength={maxLength}
        rows={2}
        readOnly={readOnly}
        disabled={inputDisabled}
        aria-label={t("dialog.preview.noteTextAria")}
        placeholder={t("dialog.preview.notePlaceholder")}
        className="w-full resize-none rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground focus:border-primary/60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
      />
      <div className="flex items-center justify-end gap-1.5">
        <Button type="button" variant="ghost" disabled={saving || returning} onClick={onCancel} className="min-h-11 px-2.5 text-xs text-muted-foreground">
          <span className="flex size-3.5 shrink-0 items-center justify-center">{returning ? busyIcon : null}</span>
          {cancelLabel ?? t("dialog.cancel")}
        </Button>
        <Button type="button" variant="outline" disabled={disabled || saving || returning || (!allowEmpty && draft.trim().length === 0)} onClick={onSave} className="min-h-11 border-primary/60 bg-primary/15 px-2.5 text-xs">
          <span className="flex size-3.5 shrink-0 items-center justify-center">{saving ? busyIcon : null}</span>
          {saveLabel ?? t("dialog.preview.saveNote")}
        </Button>
      </div>
    </div>
  );
}
