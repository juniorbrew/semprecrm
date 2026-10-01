"use client";

import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import { cn } from "@/lib/utils";
import {
  CATEGORY_DOT,
  CATEGORY_LIMITS,
  PRIORITIES,
  PRIORITY_DOT,
  supportCopy,
  type ConversationCategory,
} from "@/lib/support/model";
import { sanitizeSubject } from "@/lib/support/triage-fields";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { Conversation, ConversationPriority } from "@/types";

const CHIP =
  "inline-flex h-5 max-w-36 shrink-0 items-center gap-1.5 rounded-md px-1.5 text-xs leading-4 text-muted-foreground";

interface TriageChipsProps {
  conversation: Pick<Conversation, "category_id" | "priority" | "sentiment">;
  /** Pickable (non-archived) categories. */
  categories: ConversationCategory[];
  /** Every category, archived included, so an old choice still shows its name. */
  byId: ReadonlyMap<string, ConversationCategory>;
  /** Agent+ edits; viewers read. */
  canEdit: boolean;
  onCategory: (id: string | null) => void;
  onPriority: (priority: ConversationPriority) => void;
}

/**
 * Category + priority of a conversation: two small text-first chips, each
 * an editable popover for agents and plain text for viewers. A chip that
 * has nothing to say (no category, normal priority) is hidden for viewers.
 */
export function TriageChips({ conversation, categories, byId, canEdit, onCategory, onPriority }: TriageChipsProps) {
  const { language } = useLanguage();
  const copy = supportCopy(language);
  const category = conversation.category_id ? byId.get(conversation.category_id) : undefined;
  const priority = conversation.priority ?? "normal";

  const categoryBody = (
    <>
      {category && <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", CATEGORY_DOT[category.color])} aria-hidden />}
      <span className="truncate">{category?.name ?? copy.noCategoryShort}</span>
    </>
  );
  const priorityBody = (
    <>
      <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", PRIORITY_DOT[priority])} aria-hidden />
      <span className="truncate">{copy.priorities[priority]}</span>
    </>
  );

  return (
    <span data-no-translate data-testid="triage-chips" className="-ml-1.5 inline-flex min-w-0 items-center gap-1">
      {canEdit ? (
        <Popover>
          <PopoverTrigger
            aria-label={copy.category}
            title={copy.category}
            className={cn(CHIP, "transition-colors hover:bg-muted hover:text-foreground", !category && "opacity-70")}
          >
            {categoryBody}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-52 gap-0.5 p-1.5">
            {categories.map((cat) => (
              <OptionRow
                key={cat.id}
                selected={cat.id === conversation.category_id}
                onClick={() => onCategory(cat.id)}
                dot={CATEGORY_DOT[cat.color]}
                label={cat.name}
              />
            ))}
            {conversation.category_id && (
              <OptionRow selected={false} onClick={() => onCategory(null)} label={copy.noCategory} muted />
            )}
          </PopoverContent>
        </Popover>
      ) : (
        category && <span className={CHIP}>{categoryBody}</span>
      )}

      {canEdit ? (
        <Popover>
          <PopoverTrigger
            aria-label={copy.priority}
            title={copy.priority}
            className={cn(CHIP, "transition-colors hover:bg-muted hover:text-foreground")}
          >
            {priorityBody}
          </PopoverTrigger>
          <PopoverContent align="start" className="w-44 gap-0.5 p-1.5">
            {PRIORITIES.map((value) => (
              <OptionRow
                key={value}
                selected={value === priority}
                onClick={() => onPriority(value)}
                dot={PRIORITY_DOT[value]}
                label={copy.priorities[value]}
              />
            ))}
            {conversation.sentiment && (
              <p className="px-2 pb-0.5 pt-1.5 text-xs text-muted-foreground">
                {copy.sentiment}: {copy.sentiments[conversation.sentiment]}
              </p>
            )}
          </PopoverContent>
        </Popover>
      ) : (
        priority !== "normal" && <span className={CHIP}>{priorityBody}</span>
      )}
    </span>
  );
}

function OptionRow({
  selected,
  onClick,
  dot,
  label,
  muted,
}: {
  selected: boolean;
  onClick: () => void;
  dot?: string;
  label: string;
  muted?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={selected}
      className={cn(
        "flex h-8 w-full items-center gap-2 rounded-md px-2 text-left text-sm hover:bg-muted",
        muted ? "text-muted-foreground" : "text-popover-foreground",
      )}
    >
      {dot ? <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} aria-hidden /> : <span className="w-1.5 shrink-0" />}
      <span className="flex-1 truncate">{label}</span>
      {selected && <Check className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />}
    </button>
  );
}

interface SubjectLineProps {
  subject: string | null | undefined;
  canEdit: boolean;
  /** `null` clears the subject. */
  onSave: (subject: string | null) => void;
}

/** One muted line under the contact name; click (agents) to edit in place. */
export function SubjectLine({ subject, canEdit, onSave }: SubjectLineProps) {
  const { language } = useLanguage();
  const copy = supportCopy(language);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(subject ?? "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  if (!canEdit) {
    return subject ? (
      <p data-no-translate data-testid="subject-line" title={subject} className="truncate text-xs leading-4 text-muted-foreground">
        {subject}
      </p>
    ) : null;
  }

  if (editing) {
    const commit = () => {
      setEditing(false);
      const next = sanitizeSubject(draft);
      if (next !== (subject ?? null)) onSave(next);
    };
    return (
      <input
        ref={inputRef}
        data-no-translate
        data-testid="subject-input"
        value={draft}
        maxLength={CATEGORY_LIMITS.subject}
        aria-label={copy.subjectLabel}
        placeholder={copy.subjectPlaceholder}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit();
          if (e.key === "Escape") {
            setDraft(subject ?? "");
            setEditing(false);
          }
        }}
        className="h-4 w-full min-w-0 bg-transparent p-0 text-xs leading-4 text-foreground outline-none placeholder:text-muted-foreground"
      />
    );
  }

  return (
    <button
      type="button"
      data-no-translate
      data-testid="subject-line"
      title={subject ?? copy.subjectAdd}
      onClick={() => {
        setDraft(subject ?? "");
        setEditing(true);
      }}
      className={cn(
        "block h-4 w-full min-w-0 truncate text-left text-xs leading-4 transition-colors",
        subject
          ? "text-muted-foreground hover:text-foreground"
          : "text-muted-foreground/60 opacity-0 hover:text-foreground focus-visible:opacity-100 group-hover/header:opacity-100",
      )}
    >
      {subject ?? copy.subjectAdd}
    </button>
  );
}
