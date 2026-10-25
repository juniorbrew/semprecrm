// ============================================================
// Agenda configuration writes (services, resources + children, settings).
// RLS (096) already limits writes to admin+ of the account; every query
// also filters by account_id so a forged id from another tenant is a 404.
//
// ponytail: a resource's service links / hours / exceptions are replaced as
// delete-then-insert through PostgREST (not one transaction). Everything is
// validated first, and a retry heals a half-saved schedule; move into one
// SECURITY DEFINER RPC if partial saves ever show up in practice.
// ============================================================

import type { AgendaDb } from './data';
import { AgendaError, fromRpcError } from './errors';
import { DEFAULT_REMINDER_SETTINGS, type ReminderSettings } from './reminders-core';
import type { AgendaResource, AgendaService, AgendaSettings, DayException, WorkingInterval } from './types';

type Patch = Record<string, unknown>;

function must<T>(res: { data: T | null; error: { code?: string; message: string } | null }): T {
  if (res.error) throw fromRpcError(res.error);
  if (res.data === null) throw new AgendaError('not_found');
  return res.data;
}

function ok(res: { error: { code?: string; message: string } | null }): void {
  if (res.error) throw fromRpcError(res.error);
}

// ---------------- services ----------------

export async function createService(db: AgendaDb, accountId: string, input: Patch): Promise<AgendaService> {
  const res = await db.from('agenda_services').insert({ ...input, account_id: accountId }).select('*').single();
  return must(res) as AgendaService;
}

export async function updateService(db: AgendaDb, accountId: string, id: string, patch: Patch): Promise<AgendaService> {
  if (Object.keys(patch).length === 0) throw new AgendaError('validation', 'Nada para alterar.');
  const res = await db
    .from('agenda_services')
    .update(patch)
    .eq('id', id)
    .eq('account_id', accountId)
    .select('*')
    .maybeSingle();
  return must(res) as AgendaService;
}

export async function deleteService(db: AgendaDb, accountId: string, id: string): Promise<void> {
  const res = await db.from('agenda_services').delete().eq('id', id).eq('account_id', accountId).select('id');
  if (res.error) {
    const err = fromRpcError(res.error);
    if (err.code === 'conflict') {
      throw new AgendaError('conflict', 'Esse serviço já tem agendamentos. Desative-o em vez de excluir.');
    }
    throw err;
  }
  if (!res.data || res.data.length === 0) throw new AgendaError('not_found');
}

// ---------------- resources ----------------

export interface ResourceInput {
  name?: string;
  kind?: string;
  user_id?: string | null;
  color?: string | null;
  is_active?: boolean;
  sort_order?: number;
  service_ids?: string[];
  hours?: Pick<WorkingInterval, 'weekday' | 'start_minute' | 'end_minute'>[];
  exceptions?: Pick<DayException, 'on_date' | 'kind' | 'start_minute' | 'end_minute' | 'note'>[];
}

async function assertServicesBelong(db: AgendaDb, accountId: string, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const res = await db.from('agenda_services').select('id').eq('account_id', accountId).in('id', ids);
  if (res.error) throw fromRpcError(res.error);
  if ((res.data ?? []).length !== new Set(ids).size) {
    throw new AgendaError('validation', 'Serviço inválido na lista do profissional.');
  }
}

export async function saveResource(
  db: AgendaDb,
  accountId: string,
  id: string | null,
  input: ResourceInput,
): Promise<AgendaResource> {
  const { service_ids, hours, exceptions, ...columns } = input;
  if (service_ids) await assertServicesBelong(db, accountId, service_ids);

  let resource: AgendaResource;
  if (id === null) {
    resource = must(
      await db.from('agenda_resources').insert({ ...columns, account_id: accountId }).select('*').single(),
    ) as AgendaResource;
  } else if (Object.keys(columns).length > 0) {
    resource = must(
      await db.from('agenda_resources').update(columns).eq('id', id).eq('account_id', accountId).select('*').maybeSingle(),
    ) as AgendaResource;
  } else {
    resource = must(
      await db.from('agenda_resources').select('*').eq('id', id).eq('account_id', accountId).maybeSingle(),
    ) as AgendaResource;
  }

  const rid = resource.id;
  if (service_ids) {
    ok(await db.from('agenda_resource_services').delete().eq('resource_id', rid).eq('account_id', accountId));
    if (service_ids.length > 0) {
      ok(
        await db.from('agenda_resource_services').insert(
          [...new Set(service_ids)].map((service_id) => ({ resource_id: rid, service_id, account_id: accountId })),
        ),
      );
    }
  }
  if (hours) {
    ok(await db.from('agenda_working_hours').delete().eq('resource_id', rid).eq('account_id', accountId));
    if (hours.length > 0) {
      ok(await db.from('agenda_working_hours').insert(hours.map((h) => ({ ...h, resource_id: rid, account_id: accountId }))));
    }
  }
  if (exceptions) {
    ok(await db.from('agenda_exceptions').delete().eq('resource_id', rid).eq('account_id', accountId));
    if (exceptions.length > 0) {
      ok(await db.from('agenda_exceptions').insert(exceptions.map((e) => ({ ...e, resource_id: rid, account_id: accountId }))));
    }
  }
  return resource;
}

export async function deleteResource(db: AgendaDb, accountId: string, id: string): Promise<void> {
  const res = await db.from('agenda_resources').delete().eq('id', id).eq('account_id', accountId).select('id');
  if (res.error) {
    const err = fromRpcError(res.error);
    if (err.code === 'conflict') {
      throw new AgendaError('conflict', 'Esse profissional já tem agendamentos. Desative-o em vez de excluir.');
    }
    throw err;
  }
  if (!res.data || res.data.length === 0) throw new AgendaError('not_found');
}

// ---------------- settings ----------------

export async function saveSettings(db: AgendaDb, accountId: string, settings: AgendaSettings): Promise<AgendaSettings> {
  const res = await db
    .from('agenda_settings')
    .upsert({ ...settings, account_id: accountId }, { onConflict: 'account_id' })
    .select('min_notice_minutes, max_days_ahead, slot_step_minutes')
    .single();
  return must(res) as AgendaSettings;
}

// ---------------- WhatsApp reminders (097) ----------------

const REMINDER_COLUMNS = 'enabled, first_offset_minutes, second_offset_minutes, message_text, template_name, template_language';

export async function loadReminderSettings(db: AgendaDb, accountId: string): Promise<ReminderSettings> {
  const res = await db.from('agenda_reminder_settings').select(REMINDER_COLUMNS).eq('account_id', accountId).maybeSingle();
  if (res.error) throw fromRpcError(res.error);
  return (res.data as ReminderSettings | null) ?? DEFAULT_REMINDER_SETTINGS;
}

/** Saving replans the pending reminders of the account's future appointments (trigger, migration 097). */
export async function saveReminderSettings(db: AgendaDb, accountId: string, settings: ReminderSettings): Promise<ReminderSettings> {
  const res = await db
    .from('agenda_reminder_settings')
    .upsert({ ...settings, account_id: accountId }, { onConflict: 'account_id' })
    .select(REMINDER_COLUMNS)
    .single();
  return must(res) as ReminderSettings;
}
