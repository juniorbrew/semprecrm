import type { ReactNode } from "react";

import type { Language } from "@/lib/i18n";
import {
  BACKLOG_BUCKETS,
  formatDuration,
  formatScore,
  percent,
  slaRate,
  type BacklogRow,
  type ReportRow,
  type ReportsCopy,
} from "@/lib/support/reports";

const PRIORITY_ORDER = ["urgent", "high", "normal", "low"];

/** A value and a thin bar sized against the largest value of its column. */
function Bar({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.max(value > 0 ? 4 : 0, Math.round((value / max) * 100)) : 0;
  return (
    <span className="flex items-center gap-2">
      <span className="w-10 shrink-0 text-right tabular-nums">{value}</span>
      <span aria-hidden className="h-1 w-24 shrink-0 overflow-hidden rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary/70" style={{ width: `${width}%` }} />
      </span>
    </span>
  );
}

/** Small muted uppercase heading, same as the inbox contact panel. */
const HEADING = "text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground";

/** Header cells stick to the top of the table's own scroll box. */
const TH = "sticky top-0 z-10 bg-background pb-2 pr-4 font-normal";

export type SlaTone = "ok" | "warn" | "bad";

/**
 * How worrying a kept-deadline rate is: 90% or more is fine, 75–89% needs
 * attention, below 75% is at risk. `null` (nothing judged) has no tone.
 */
export function slaTone(rate: number | null): SlaTone | null {
  if (rate === null) return null;
  if (rate >= 90) return "ok";
  if (rate >= 75) return "warn";
  return "bad";
}

const TONE_DOT: Record<SlaTone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  bad: "bg-red-500",
};

/** The SLA rate as dot + text: the only status colour on the page. */
function SlaValue({ rate }: { rate: number | null }) {
  const tone = slaTone(rate);
  if (rate === null || tone === null) return <>—</>;
  return (
    <span className="inline-flex items-center gap-1.5" data-sla-tone={tone}>
      <span aria-hidden className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[tone]}`} />
      {`${rate}%`}
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-6 first:border-t-0 first:pt-0">
      <h2 className={HEADING}>{title}</h2>
      {children}
    </section>
  );
}

/** One number of the KPI strip: label, value, one quiet line of detail. */
function Kpi({ label, children, detail }: { label: string; children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1 py-3 pr-4">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="text-xl font-semibold tabular-nums tracking-tight text-foreground">{children}</dd>
      {detail ? <dd className="text-[11px] leading-snug text-muted-foreground tabular-nums">{detail}</dd> : null}
    </div>
  );
}

const times = (copy: ReportsCopy, median: number | null, p90: number | null) =>
  median === null && p90 === null
    ? ""
    : `${copy.metrics.median} ${formatDuration(median)} · ${copy.metrics.p90} ${formatDuration(p90)}`;

/** "Visão geral": one row per number, the detail beside it. */
export function OverviewSection({ row, copy, language }: { row: ReportRow | undefined; copy: ReportsCopy; language: Language }) {
  const m = copy.metrics;
  if (!row || (row.opened === 0 && row.resolved === 0 && row.backlog === 0 && row.csat_sent === 0)) {
    return (
      <Section title={copy.overview}>
        <p className="text-sm text-muted-foreground" data-testid="reports-empty">
          {copy.empty}
        </p>
      </Section>
    );
  }
  const sla = slaRate(row.sla_met, row.sla_missed);
  const reopen = percent(row.reopened, row.opened);
  const answered = percent(row.csat_answered, row.csat_sent);
  return (
    <Section title={copy.overview}>
      <dl className="grid grid-cols-2 gap-x-4 border-t border-border sm:grid-cols-4" data-testid="reports-overview">
        <Kpi label={m.opened}>{row.opened}</Kpi>
        <Kpi label={m.resolved}>{row.resolved}</Kpi>
        <Kpi label={m.backlog}>{row.backlog}</Kpi>
        <Kpi label={m.sla} detail={sla === null ? "" : `${row.sla_met} / ${row.sla_met + row.sla_missed}`}>
          <SlaValue rate={sla} />
        </Kpi>
        <Kpi label={m.firstResponse} detail={times(copy, row.fr_median_seconds, row.fr_p90_seconds)}>
          {formatDuration(row.fr_avg_seconds)}
        </Kpi>
        <Kpi label={m.resolution} detail={times(copy, row.res_median_seconds, row.res_p90_seconds)}>
          {formatDuration(row.res_avg_seconds)}
        </Kpi>
        <Kpi label={m.reopenRate} detail={reopen === null ? "" : `${row.reopened} / ${row.opened}`}>
          {reopen === null ? "—" : `${reopen}%`}
        </Kpi>
        <Kpi label={m.csat} detail={row.csat_sent > 0 ? `${m.csatRate} ${m.csatAnswers(row.csat_answered, row.csat_sent)}${answered === null ? "" : ` · ${answered}%`}` : ""}>
          {formatScore(row.csat_avg, language)}
        </Kpi>
      </dl>
    </Section>
  );
}

/** Category / team / agent: a row per group with a bar on the volume. */
export function GroupSection({
  title,
  rows,
  labelFor,
  copy,
  language,
  testId,
}: {
  title: string;
  rows: ReportRow[];
  labelFor: (key: string | null) => string;
  copy: ReportsCopy;
  language: Language;
  testId: string;
}) {
  const live = rows.filter((r) => r.opened > 0 || r.resolved > 0 || r.csat_sent > 0 || r.backlog > 0);
  if (live.length === 0) return null;
  const max = Math.max(...live.map((r) => r.opened));
  const c = copy.columns;
  return (
    <Section title={title}>
      <div className="max-h-[26rem] overflow-auto">
        <table className="w-full min-w-[40rem] text-sm" data-testid={testId}>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className={TH} />
              <th scope="col" className={TH}>{c.opened}</th>
              <th scope="col" className={`${TH} text-right`}>{c.resolved}</th>
              <th scope="col" className={`${TH} text-right`}>{c.firstResponse}</th>
              <th scope="col" className={`${TH} text-right`}>{c.resolution}</th>
              <th scope="col" className={`${TH} pr-0 text-right`}>{c.csat}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border border-t border-border">
            {live.map((r) => (
              <tr key={r.group_key ?? "none"}>
                <th scope="row" className="max-w-56 truncate py-2 pr-4 text-left font-normal text-foreground">
                  {labelFor(r.group_key)}
                </th>
                <td className="py-2 pr-4">
                  <Bar value={r.opened} max={max} />
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{r.resolved}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{formatDuration(r.fr_avg_seconds)}</td>
                <td className="py-2 pr-4 text-right tabular-nums">{formatDuration(r.res_avg_seconds)}</td>
                <td className="py-2 text-right tabular-nums">{formatScore(r.csat_avg, language)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** "Por prioridade": volume and how many deadlines were kept. */
export function PrioritySection({ rows, copy }: { rows: ReportRow[]; copy: ReportsCopy }) {
  const live = rows
    .filter((r) => r.opened > 0 || r.sla_met + r.sla_missed > 0)
    .sort((a, b) => PRIORITY_ORDER.indexOf(a.group_key ?? "") - PRIORITY_ORDER.indexOf(b.group_key ?? ""));
  if (live.length === 0) return null;
  const max = Math.max(...live.map((r) => r.opened));
  const c = copy.columns;
  return (
    <Section title={copy.byPriority}>
      <div className="max-h-[26rem] overflow-auto">
        <table className="w-full min-w-[34rem] text-sm" data-testid="reports-priority">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className={TH} />
              <th scope="col" className={TH}>{c.opened}</th>
              <th scope="col" className={`${TH} text-right`}>{c.met}</th>
              <th scope="col" className={`${TH} text-right`}>{c.missed}</th>
              <th scope="col" className={`${TH} pr-0 text-right`}>{c.sla}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border border-t border-border">
            {live.map((r) => {
              const rate = slaRate(r.sla_met, r.sla_missed);
              return (
                <tr key={r.group_key ?? "none"}>
                  <th scope="row" className="py-2 pr-4 text-left font-normal text-foreground">
                    {copy.priorities[r.group_key ?? ""] ?? copy.none}
                  </th>
                  <td className="py-2 pr-4">
                    <Bar value={r.opened} max={max} />
                  </td>
                  <td className="py-2 pr-4 text-right tabular-nums">{r.sla_met}</td>
                  <td className="py-2 pr-4 text-right tabular-nums">{r.sla_missed}</td>
                  <td className="py-2 text-right tabular-nums">
                    <SlaValue rate={rate} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Section>
  );
}

/** "Fila por idade": open and pending conversations by how long they have been waiting. */
export function BacklogSection({ rows, copy }: { rows: BacklogRow[]; copy: ReportsCopy }) {
  const byBucket = new Map(rows.map((r) => [r.bucket, r.total]));
  const total = BACKLOG_BUCKETS.reduce((sum, b) => sum + (byBucket.get(b) ?? 0), 0);
  if (total === 0) return null;
  const max = Math.max(...BACKLOG_BUCKETS.map((b) => byBucket.get(b) ?? 0));
  return (
    <Section title={copy.backlogByAge}>
      <table className="w-full max-w-md text-sm" data-testid="reports-backlog">
        <tbody className="divide-y divide-border border-t border-border">
          {BACKLOG_BUCKETS.map((b) => (
            <tr key={b}>
              <th scope="row" className="py-2 pr-4 text-left font-normal text-foreground">
                {copy.buckets[b]}
              </th>
              <td className="py-2">
                <Bar value={byBucket.get(b) ?? 0} max={max} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </Section>
  );
}
