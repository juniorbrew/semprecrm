"use client";

import { useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { useLanguage } from "@/hooks/use-language";
import {
  CUSTOM_FIELD_TYPES,
  createCustomField,
  isDuplicateFieldName,
  normalizeFieldName,
  type CustomFieldType,
} from "@/lib/contacts/custom-fields";
import type { CustomField } from "@/types";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

const SELECT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-muted px-2.5 text-sm text-foreground outline-none focus:border-primary focus:ring-1 focus:ring-primary";

/** English labels for `field_type`; translated through `t()`. */
const TYPE_LABELS: Record<CustomFieldType, string> = { text: "Text" };

interface NewCustomFieldDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Already-loaded definitions, for the duplicate-name check. */
  existing: readonly Pick<CustomField, "id" | "field_name">[];
  onCreated: (field: CustomField) => void;
}

/**
 * "Novo campo" — creates an account-level custom field definition from
 * the inbox contact panel. Same rules as Settings › Campos personalizados
 * (shared `lib/contacts/custom-fields`); the row is admin-gated by RLS.
 */
export function NewCustomFieldDialog({
  open,
  onOpenChange,
  existing,
  onCreated,
}: NewCustomFieldDialogProps) {
  const { t } = useLanguage();
  const { user, accountId } = useAuth();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="border-border bg-popover text-popover-foreground sm:max-w-sm">
        <DialogHeader>
          <DialogTitle className="text-popover-foreground">{t("New field")}</DialogTitle>
          <DialogDescription className="text-muted-foreground">
            {t("Custom fields appear on every contact in this account.")}
          </DialogDescription>
        </DialogHeader>
        {/* Mounted only while open so the inputs reset on every open
            without syncing props into state in an effect. */}
        {open && (
          <NewCustomFieldForm
            existing={existing}
            userId={user?.id ?? null}
            accountId={accountId ?? null}
            typeLabel={(type) => t(TYPE_LABELS[type])}
            onCancel={() => onOpenChange(false)}
            onCreated={(field) => {
              onCreated(field);
              onOpenChange(false);
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

function NewCustomFieldForm({
  existing,
  userId,
  accountId,
  typeLabel,
  onCancel,
  onCreated,
}: {
  existing: readonly Pick<CustomField, "id" | "field_name">[];
  userId: string | null;
  accountId: string | null;
  typeLabel: (type: CustomFieldType) => string;
  onCancel: () => void;
  onCreated: (field: CustomField) => void;
}) {
  const { t } = useLanguage();
  const [name, setName] = useState("");
  const [fieldType, setFieldType] = useState<CustomFieldType>("text");
  const [saving, setSaving] = useState(false);

  const normalized = normalizeFieldName(name);
  const duplicate = normalized ? isDuplicateFieldName(existing, normalized) : false;
  const invalid = !normalized || duplicate;

  async function handleCreate() {
    if (invalid || saving) return;
    if (!userId || !accountId) {
      toast.error(t("Your profile is not linked to an account."));
      return;
    }
    setSaving(true);
    try {
      const field = await createCustomField(createClient(), {
        name: normalized,
        fieldType,
        userId,
        accountId,
      });
      toast.success(t("Field created"));
      onCreated(field);
    } catch (err) {
      console.error("Failed to create custom field:", err);
      toast.error(t("Could not create field. You may not have permission."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="grid gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void handleCreate();
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor="new-custom-field-name" className="text-muted-foreground">
          {t("Field name")}
        </Label>
        <Input
          id="new-custom-field-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("e.g. ZIP code, lead source")}
          autoFocus
          aria-invalid={duplicate || undefined}
          className="border-border bg-muted text-foreground"
        />
        {duplicate && (
          <p className="text-xs text-destructive">
            {t("A field with this name already exists.")}
          </p>
        )}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="new-custom-field-type" className="text-muted-foreground">
          {t("Type")}
        </Label>
        <select
          id="new-custom-field-type"
          value={fieldType}
          onChange={(e) => setFieldType(e.target.value as CustomFieldType)}
          className={SELECT_CLASS}
        >
          {CUSTOM_FIELD_TYPES.map((type) => (
            <option key={type} value={type}>
              {typeLabel(type)}
            </option>
          ))}
        </select>
      </div>
      <DialogFooter>
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={saving}
          className="border-border bg-transparent text-muted-foreground hover:bg-muted"
        >
          {t("Cancel")}
        </Button>
        <Button
          type="submit"
          disabled={invalid || saving}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {saving && <Loader2 className="size-4 animate-spin" />}
          {saving ? t("Saving...") : t("Create field")}
        </Button>
      </DialogFooter>
    </form>
  );
}
