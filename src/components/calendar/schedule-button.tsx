"use client";

import { useState, type ReactNode } from "react";
import { CalendarPlus } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import type { CalendarEvent, CalendarEventInput } from "@/lib/calendar";
import { Button } from "@/components/ui/button";

import { EventDrawer } from "./event-drawer";

export interface ScheduleButtonProps {
  /** Links + title the drawer opens with. */
  defaults?: Partial<CalendarEventInput>;
  /** Task drawer: offer "set the task's due date to the start". */
  offerTaskDue?: boolean;
  onCreated?: (event: CalendarEvent, extras: { setTaskDue: boolean }) => void;
  /** Custom trigger content; default is an icon + "Schedule". */
  children?: ReactNode;
  variant?: "outline" | "ghost" | "default";
  size?: "sm" | "xs" | "default";
  className?: string;
  disabled?: boolean;
}

/**
 * "Agendar" button that opens the appointment drawer in create mode
 * with the given prefill. Drop it in any screen that knows a contact
 * / conversation / deal / task / chat thread.
 */
export function ScheduleButton({
  defaults,
  offerTaskDue,
  onCreated,
  children,
  variant = "outline",
  size = "sm",
  className,
  disabled,
}: ScheduleButtonProps) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" variant={variant} size={size} disabled={disabled} onClick={() => setOpen(true)} className={className}>
        {children ?? (
          <>
            <CalendarPlus className="h-3.5 w-3.5" />
            {t("Schedule appointment")}
          </>
        )}
      </Button>
      <EventDrawer
        open={open}
        onOpenChange={setOpen}
        event={null}
        defaults={defaults}
        offerTaskDue={offerTaskDue}
        onCreated={onCreated}
      />
    </>
  );
}
