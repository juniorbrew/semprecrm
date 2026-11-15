// ============================================================
// Platform → Usage: pure helpers (month, signals, filter, sort, CSV).
// Counts only — nothing here ever sees conversation text or customer data.
// ============================================================

import { csvCell } from '@/lib/support/reports';
import type { Plan, PlanStatus } from '@/lib/plans';
import type { PlatformAccountRow } from '@/types';
import { getAccountHealth } from './overview';

/** One row of platform_usage() (numeric columns arrive as numbers or strings). */
export interface PlatformUsageRecord {
  account_id: string;
  conversations: number | string;
  messages_received: number | string;
  messages_sent: number | string;
  ai_calls: number | string;
  ai_cost_usd: number | string;
  contacts_7d: number | string;
  last_activity_at: string | null;
}

export interface UsageRow {
  id: string;
  name: string;
  plan: Plan;
  status: PlanStatus;
  blocked: boolean;
  users: number;
  maxUsers: number | null;
  channels: number;
  maxChannels: number | null;
  conversations: number;
  received: number;
  sent: number;
  aiCalls: number;
  aiCostUsd: number;
  contacts7d: number;
  lastActivityAt: string | null;
  nearLimit: boolean;
  idle: boolean;
}

export const NEAR_LIMIT_RATIO = 0.8;
export const IDLE_DAYS = 14;
export const MIN_MONTH = '2024-01';

/** Month (YYYY-MM) of `now` in America/Sao_Paulo. */
export function currentMonth(now: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value;
  return `${get('year')}-${get('month')}`;
}

/** YYYY-MM between MIN_MONTH and the current month, else null. */
export function parseMonth(value: unknown, now: Date): string | null {
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) {
    return null;
  }
  return value >= MIN_MONTH && value <= currentMonth(now) ? value : null;
}

function nearLimit(used: number, max: number | null): boolean {
  return max !== null && used > 0 && used >= NEAR_LIMIT_RATIO * max;
}

export function isIdle(lastActivityAt: string | null, now: Date): boolean {
  if (!lastActivityAt) return true;
  const last = new Date(lastActivityAt).getTime();
  return Number.isNaN(last) || now.getTime() - last > IDLE_DAYS * 86_400_000;
}

export function buildUsageRows(
  accounts: PlatformAccountRow[],
  usage: PlatformUsageRecord[],
  now: Date
): UsageRow[] {
  const byAccount = new Map(usage.map((u) => [u.account_id, u]));
  return accounts.map((account) => {
    const { ent } = getAccountHealth(account, now);
    const u = byAccount.get(account.id);
    const users =
      Number(account.members_count) + Number(account.pending_invites_count);
    const channels = Number(account.channels_count);
    const lastActivityAt = u?.last_activity_at ?? null;
    return {
      id: account.id,
      name: account.name,
      plan: ent.plan,
      status: ent.status,
      blocked: !!ent.blocked,
      users,
      maxUsers: ent.limits.max_users,
      channels,
      maxChannels: ent.limits.max_channels,
      conversations: Number(u?.conversations ?? 0),
      received: Number(u?.messages_received ?? 0),
      sent: Number(u?.messages_sent ?? 0),
      aiCalls: Number(u?.ai_calls ?? 0),
      aiCostUsd: Number(u?.ai_cost_usd ?? 0),
      contacts7d: Number(u?.contacts_7d ?? 0),
      lastActivityAt,
      nearLimit:
        nearLimit(users, ent.limits.max_users) ||
        nearLimit(channels, ent.limits.max_channels),
      idle: isIdle(lastActivityAt, now),
    };
  });
}

export type UsageSignal = 'all' | 'near_limit' | 'idle';
export interface UsageFilters {
  plan: 'all' | Plan;
  signal: UsageSignal;
}

export function filterUsageRows(
  rows: UsageRow[],
  { plan, signal }: UsageFilters
): UsageRow[] {
  return rows.filter(
    (r) =>
      (plan === 'all' || r.plan === plan) &&
      (signal === 'all' || (signal === 'near_limit' ? r.nearLimit : r.idle))
  );
}

export type UsageSortKey =
  | 'name'
  | 'plan'
  | 'status'
  | 'users'
  | 'channels'
  | 'conversations'
  | 'received'
  | 'sent'
  | 'aiCalls'
  | 'aiCostUsd'
  | 'contacts7d'
  | 'lastActivityAt';

/** Stable sort; a company that was never active is always last on "last activity". */
export function sortUsageRows(
  rows: UsageRow[],
  key: UsageSortKey,
  dir: 'asc' | 'desc'
): UsageRow[] {
  const sign = dir === 'asc' ? 1 : -1;
  const value = (r: UsageRow): string | number | null =>
    key === 'lastActivityAt'
      ? r.lastActivityAt
        ? new Date(r.lastActivityAt).getTime()
        : null
      : key === 'name'
        ? r.name.toLocaleLowerCase()
        : r[key];
  return [...rows].sort((a, b) => {
    const x = value(a);
    const y = value(b);
    if (x === null || y === null) {
      return x === y ? 0 : x === null ? 1 : -1;
    }
    if (x === y) return 0;
    return (x < y ? -1 : 1) * sign;
  });
}

export const USAGE_CSV_HEADER = [
  'Empresa',
  'Plano',
  'Situação',
  'Usuários',
  'Limite de usuários',
  'Números',
  'Limite de números',
  'Conversas no mês',
  'Mensagens recebidas',
  'Mensagens enviadas',
  'Chamadas de IA',
  'Custo da IA (USD)',
  'Pessoas novas (7 dias)',
  'Última atividade',
  'Perto do limite',
  'Sem uso há 14 dias',
] as const;

/** The visible rows as CSV (counts only; the company name is the one text field). */
export function usageToCsv(rows: UsageRow[]): string {
  const lines = [USAGE_CSV_HEADER.map(csvCell).join(';')];
  for (const r of rows) {
    lines.push(
      [
        r.name,
        r.plan,
        r.blocked && r.status === 'trial' ? 'trial_expired' : r.status,
        r.users,
        r.maxUsers,
        r.channels,
        r.maxChannels,
        r.conversations,
        r.received,
        r.sent,
        r.aiCalls,
        r.aiCostUsd.toFixed(2),
        r.contacts7d,
        r.lastActivityAt,
        r.nearLimit ? 'sim' : 'nao',
        r.idle ? 'sim' : 'nao',
      ]
        .map(csvCell)
        .join(';')
    );
  }
  return `﻿${lines.join('\r\n')}\r\n`;
}
