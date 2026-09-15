"use client";

import { CalendarBoard } from "@/components/calendar";

/** /agenda — the account's calendar (module `calendar`, migration 040). */
export default function AgendaPage() {
  return (
    <div className="h-full min-h-[calc(100vh-7rem)]">
      <CalendarBoard />
    </div>
  );
}
