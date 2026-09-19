"use client";

import { useRef, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useLanguage } from "@/hooks/use-language";
import { setContactCustomValue } from "@/lib/contacts/custom-fields";
import { formatCustomFieldValue, isIsoDate } from "@/components/contacts/custom-field-display";
import type { CustomField } from "@/types";
import { cn } from "@/lib/utils";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

interface CustomFieldValueProps {
  contactId: string;
  field: CustomField;
  /** Stored value ("" when the contact has no row for this field). */
  value: string;
  /** Called with the stored value after a successful save. */
  onSaved: (fieldId: string, value: string) => void;
  /** Rendered when the value is empty. */
  emptyLabel: string;
  /** Read-only rendering (viewers without write access). */
  disabled?: boolean;
}

/**
 * One row of the panel's custom-field list. Click the value to edit it
 * inline; Enter / blur saves (upsert into `contact_custom_values`, delete
 * when cleared), Esc cancels. The row stays a `dt`/`dd` pair so the list
 * keeps its definition-list semantics.
 */
export function CustomFieldValue({
  contactId,
  field,
  value,
  onSaved,
  emptyLabel,
  disabled = false,
}: CustomFieldValueProps) {
  const { t, language } = useLanguage();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [saving, setSaving] = useState(false);
  // Esc flips this so the blur that follows the input unmounting doesn't
  // also try to save the abandoned draft.
  const cancelledRef = useRef(false);

  function startEditing() {
    if (disabled || saving) return;
    setDraft(value);
    cancelledRef.current = false;
    setEditing(true);
  }

  async function commit() {
    if (cancelledRef.current) {
      cancelledRef.current = false;
      return;
    }
    setEditing(false);
    const next = draft.trim();
    if (next === value.trim()) return;
    setSaving(true);
    try {
      const stored = await setContactCustomValue(createClient(), {
        contactId,
        fieldId: field.id,
        value: next,
      });
      onSaved(field.id, stored);
    } catch (err) {
      console.error("Failed to save custom field value:", err);
      toast.error(t("Could not save the field value"));
    } finally {
      setSaving(false);
    }
  }

  function cancel() {
    cancelledRef.current = true;
    setDraft(value);
    setEditing(false);
  }

  // An ISO date reads as a locale date (14/03/1991); the input still
  // edits the stored ISO text.
  const shown = formatCustomFieldValue(value.trim(), language);

  return (
    <div className="flex items-center justify-between gap-3 px-2.5 py-1">
      <dt className="min-w-0 shrink-0 truncate text-[11px] text-muted-foreground">
        {field.field_name}
      </dt>
      <dd className="min-w-0 flex-1 text-right text-xs">
        {editing ? (
          <input
            type={isIsoDate(value) ? "date" : "text"}
            value={draft}
            autoFocus
            aria-label={field.field_name}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => void commit()}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                e.currentTarget.blur();
              } else if (e.key === "Escape") {
                e.preventDefault();
                cancel();
              }
            }}
            className="h-6 w-full rounded-md border border-primary bg-background px-1.5 text-right text-xs text-foreground outline-none"
          />
        ) : (
          <button
            type="button"
            onClick={startEditing}
            disabled={disabled || saving}
            title={disabled ? undefined : t("Click to edit")}
            className={cn(
              "inline-flex h-6 max-w-full items-center justify-end gap-1 rounded-md px-1.5 text-right transition-colors",
              !disabled && "hover:bg-muted",
              shown ? "text-foreground" : "text-muted-foreground/60",
            )}
          >
            {saving && <Loader2 className="h-3 w-3 shrink-0 animate-spin" />}
            <span className="truncate" title={shown || undefined}>
              {shown || emptyLabel}
            </span>
          </button>
        )}
      </dd>
    </div>
  );
}
