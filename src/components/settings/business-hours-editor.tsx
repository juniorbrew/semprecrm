"use client";

import { Clock, Globe, Moon, Plus, Shuffle, X } from "lucide-react";

import { useLanguage } from "@/hooks/use-language";
import { PREFERENCE_LIMITS, WEEKDAYS, timeToMinutes } from "@/lib/account-preferences";
import { TIMEZONE_OPTIONS } from "@/lib/business-hours";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { BusinessHours, BusinessHoursRange, Weekday } from "@/types";

const SELECT_CLASS =
  "rounded-md border border-border bg-card px-2 py-1.5 text-sm text-foreground focus:border-primary focus:outline-none disabled:opacity-60";

const TIME_INPUT_CLASS =
  "w-[5.5rem] rounded-md border border-border bg-card px-2 py-1 text-sm tabular-nums text-foreground focus:border-primary focus:outline-none disabled:opacity-60";

/** English labels; `t()` maps them to pt-BR. */
const DAY_LABEL: Record<Weekday, string> = {
  mon: "Monday",
  tue: "Tuesday",
  wed: "Wednesday",
  thu: "Thursday",
  fri: "Friday",
  sat: "Saturday",
  sun: "Sunday",
};

/** True when every range is well-formed and start < end. */
export function businessHoursValid(hours: BusinessHours): boolean {
  for (const day of WEEKDAYS) {
    for (const r of hours.days[day] ?? []) {
      const s = timeToMinutes(r.start);
      const e = timeToMinutes(r.end);
      if (s === null || e === null || s >= e) return false;
    }
  }
  return true;
}

interface BusinessHoursEditorProps {
  value: BusinessHours;
  onChange: (next: BusinessHours) => void;
  disabled?: boolean;
}

/**
 * Per-weekday ranges (up to two) plus the timezone. A day with no
 * ranges is closed; the second range is meant for a lunch break.
 */
export function BusinessHoursEditor({ value, onChange, disabled }: BusinessHoursEditorProps) {
  const { t } = useLanguage();

  function setDay(day: Weekday, ranges: BusinessHoursRange[]) {
    onChange({ ...value, days: { ...value.days, [day]: ranges } });
  }

  function patchRange(day: Weekday, index: number, patch: Partial<BusinessHoursRange>) {
    const ranges = value.days[day].map((r, i) => (i === index ? { ...r, ...patch } : r));
    setDay(day, ranges);
  }

  function addRange(day: Weekday) {
    const ranges = value.days[day];
    if (ranges.length >= PREFERENCE_LIMITS.business_hours_ranges_per_day) return;
    const next: BusinessHoursRange =
      ranges.length === 0 ? { start: "09:00", end: "18:00" } : { start: "14:00", end: "18:00" };
    setDay(day, [...ranges, next]);
  }

  function removeRange(day: Weekday, index: number) {
    setDay(day, value.days[day].filter((_, i) => i !== index));
  }

  const timezones = TIMEZONE_OPTIONS.includes(value.timezone)
    ? TIMEZONE_OPTIONS
    : [value.timezone, ...TIMEZONE_OPTIONS];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-foreground">
          <Clock className="size-4 text-primary" />
          {t("Business hours")}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t(
            "When your team is available. Up to two ranges per day (for a lunch break); a day with no range is closed. Used by the out-of-hours reply below.",
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="business-hours-tz" className="flex items-center gap-1.5 text-foreground">
            <Globe className="size-3.5 text-muted-foreground" />
            {t("Timezone")}
          </Label>
          <select
            id="business-hours-tz"
            value={value.timezone}
            onChange={(e) => onChange({ ...value, timezone: e.target.value })}
            disabled={disabled}
            className={cn(SELECT_CLASS, "min-w-56")}
          >
            {timezones.map((tz) => (
              <option key={tz} value={tz}>
                {tz.replace(/_/g, " ")}
              </option>
            ))}
          </select>
        </div>

        <ul className="divide-y divide-border rounded-lg border border-border" data-testid="business-hours-days">
          {WEEKDAYS.map((day) => {
            const ranges = value.days[day] ?? [];
            const closed = ranges.length === 0;
            return (
              <li
                key={day}
                data-day={day}
                className="flex flex-col gap-2 px-3 py-2 sm:flex-row sm:items-center sm:gap-4"
              >
                <div className="flex w-36 shrink-0 items-center gap-2">
                  <Switch
                    checked={!closed}
                    disabled={disabled}
                    onCheckedChange={(checked) =>
                      setDay(day, checked ? [{ start: "09:00", end: "18:00" }] : [])
                    }
                    aria-label={`${t(DAY_LABEL[day])}: ${closed ? t("Closed") : t("Open")}`}
                  />
                  <span className={cn("text-sm font-medium", closed ? "text-muted-foreground" : "text-foreground")}>
                    {t(DAY_LABEL[day])}
                  </span>
                </div>
                <div className="flex flex-1 flex-wrap items-center gap-2">
                  {closed ? (
                    <span className="text-xs text-muted-foreground">{t("Closed")}</span>
                  ) : (
                    ranges.map((r, i) => {
                      const s = timeToMinutes(r.start);
                      const e = timeToMinutes(r.end);
                      const invalid = s === null || e === null || s >= e;
                      return (
                        <span key={i} className="inline-flex items-center gap-1.5">
                          <input
                            type="time"
                            value={r.start}
                            step={300}
                            disabled={disabled}
                            aria-label={`${t(DAY_LABEL[day])} ${t("start")} ${i + 1}`}
                            aria-invalid={invalid || undefined}
                            onChange={(ev) => patchRange(day, i, { start: ev.target.value })}
                            className={cn(TIME_INPUT_CLASS, invalid && "border-red-500")}
                          />
                          <span className="text-xs text-muted-foreground">–</span>
                          <input
                            type="time"
                            value={r.end}
                            step={300}
                            disabled={disabled}
                            aria-label={`${t(DAY_LABEL[day])} ${t("end")} ${i + 1}`}
                            aria-invalid={invalid || undefined}
                            onChange={(ev) => patchRange(day, i, { end: ev.target.value })}
                            className={cn(TIME_INPUT_CLASS, invalid && "border-red-500")}
                          />
                          {ranges.length > 1 && !disabled && (
                            <button
                              type="button"
                              aria-label={t("Remove range")}
                              onClick={() => removeRange(day, i)}
                              className="rounded-full p-0.5 text-muted-foreground transition-colors hover:text-foreground"
                            >
                              <X className="size-3.5" />
                            </button>
                          )}
                        </span>
                      );
                    })
                  )}
                  {!closed &&
                    !disabled &&
                    ranges.length < PREFERENCE_LIMITS.business_hours_ranges_per_day && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => addRange(day)}
                        className="h-7 px-2 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <Plus className="size-3.5" />
                        {t("Add range")}
                      </Button>
                    )}
                </div>
              </li>
            );
          })}
        </ul>
      </CardContent>
    </Card>
  );
}

interface OutOfHoursCardProps {
  enabled: boolean;
  message: string;
  onEnabledChange: (v: boolean) => void;
  onMessageChange: (v: string) => void;
  disabled?: boolean;
}

export function OutOfHoursCard({
  enabled,
  message,
  onEnabledChange,
  onMessageChange,
  disabled,
}: OutOfHoursCardProps) {
  const { t } = useLanguage();
  const max = PREFERENCE_LIMITS.out_of_hours_message_max_length;
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Moon className="size-4 text-primary" />
              {t("Out-of-hours reply")}
            </CardTitle>
            <CardDescription className="mt-1.5 text-muted-foreground">
              {t(
                "When a customer writes outside business hours, send this message automatically — once per conversation per day, through the same channel. On the official channel it is skipped when the 24-hour window is closed.",
              )}
            </CardDescription>
          </div>
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(v) => onEnabledChange(!!v)}
            aria-label={t("Out-of-hours reply")}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-2">
        <Label htmlFor="out-of-hours-message" className="text-foreground">
          {t("Message")}
        </Label>
        <Textarea
          id="out-of-hours-message"
          value={message}
          onChange={(e) => onMessageChange(e.target.value.slice(0, max))}
          disabled={disabled || !enabled}
          rows={3}
          className="bg-card text-foreground"
        />
        <p className="text-xs text-muted-foreground">
          {message.trim().length === 0 && enabled
            ? t("Enter a message to send outside business hours.")
            : `${message.length}/${max}`}
        </p>
      </CardContent>
    </Card>
  );
}

interface AutoAssignCardProps {
  enabled: boolean;
  onEnabledChange: (v: boolean) => void;
  disabled?: boolean;
}

export function AutoAssignCard({ enabled, onEnabledChange, disabled }: AutoAssignCardProps) {
  const { t } = useLanguage();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-foreground">
              <Shuffle className="size-4 text-primary" />
              {t("Automatic distribution")}
            </CardTitle>
            <CardDescription className="mt-1.5 text-muted-foreground">
              {t(
                "Round-robin: when a new conversation gets its first customer message and has no owner, assign it to the available member with the fewest open conversations. Members marked as away are skipped; with nobody available the conversation stays in the Radar.",
              )}
            </CardDescription>
          </div>
          <Switch
            checked={enabled}
            disabled={disabled}
            onCheckedChange={(v) => onEnabledChange(!!v)}
            aria-label={t("Automatic distribution")}
          />
        </div>
      </CardHeader>
    </Card>
  );
}
