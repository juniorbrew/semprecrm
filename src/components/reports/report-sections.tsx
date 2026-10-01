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
      <span aria-hidden className="h-1.5 w-24 shrink-0 rounded-full bg-muted">
        <span className="block h-full rounded-full bg-primary/60" style={{ width: `${width}%` }} />
      </span>
    </span>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-3 border-t border-border pt-6 first:border-t-0 first:pt-0">
      <h2 className="text-base font-semibold text-foreground">{title}</h2>
      {children}
    </section>
  );
}

function Row({ label, children, detail }: { label: string; children: ReactNode; detail?: ReactNode }) {
  return (
    <div className="grid grid-cols-[minmax(9rem,13rem)_1fr] items-baseline gap-4 py-2.5 sm:grid-cols-[minmax(9rem,13rem)_8rem_1fr]">
      <dt className="text-sm text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium tabular-nums text-foreground">{children}</dd>
      <dd className="col-span-2 text-xs text-muted-foreground tabular-nums sm:col-span-1">{detail}</dd>
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
      <dl className="divide-y divide-border border-y border-border" data-testid="reports-overview">
        <Row label={m.opened}>{row.opened}</Row>
        <Row label={m.resolved}>{row.resolved}</Row>
        <Row label={m.backlog}>{row.backlog}</Row>
        <Row label={m.firstResponse} detail={times(copy, row.fr_median_seconds, row.fr_p90_seconds)}>
          {formatDuration(row.fr_avg_seconds)}
        </Row>
        <Row label={m.resolution} detail={times(copy, row.res_median_seconds, row.res_p90_seconds)}>
          {formatDuration(row.res_avg_seconds)}
        </Row>
        <Row label={m.sla} detail={sla === null ? "" : `${row.sla_met} / ${row.sla_met + row.sla_missed}`}>
          {sla === null ? "—" : `${sla}%`}
        </Row>
        <Row label={m.reopenRate} detail={reopen === null ? "" : `${row.reopened} / ${row.opened}`}>
          {reopen === null ? "—" : `${reopen}%`}
        </Row>
        <Row label={m.csat} detail={row.csat_sent > 0 ? `${m.csatRate} ${m.csatAnswers(row.csat_answered, row.csat_sent)}${answered === null ? "" : ` · ${answered}%`}` : ""}>
          {formatScore(row.csat_avg, language)}
        </Row>
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
      <div className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm" data-testid={testId}>
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="pb-2 pr-4 font-normal" />
              <th scope="col" className="pb-2 pr-4 font-normal">{c.opened}</th>
              <th scope="col" className="pb-2 pr-4 text-right font-normal">{c.resolved}</th>
              <th scope="col" className="pb-2 pr-4 text-right font-normal">{c.firstResponse}</th>
              <th scope="col" className="pb-2 pr-4 text-right font-normal">{c.resolution}</th>
              <th scope="col" className="pb-2 text-right font-normal">{c.csat}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border border-y border-border">
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
      <div className="overflow-x-auto">
        <table className="w-full min-w-[34rem] text-sm" data-testid="reports-priority">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th scope="col" className="pb-2 pr-4 font-normal" />
              <th scope="col" className="pb-2 pr-4 font-normal">{c.opened}</th>
              <th scope="col" className="pb-2 pr-4 text-right font-normal">{c.met}</th>
              <th scope="col" className="pb-2 pr-4 text-right font-normal">{c.missed}</th>
              <th scope="col" className="pb-2 text-right font-normal">{c.sla}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border border-y border-border">
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
                  <td className="py-2 text-right tabular-nums">{rate === null ? "—" : `${rate}%`}</td>
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
        <tbody className="divide-y divide-border border-y border-border">
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
