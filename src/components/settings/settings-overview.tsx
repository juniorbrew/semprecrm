'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { ChevronRight, Loader2 } from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useAuth, useEntitlements } from '@/hooks/use-auth';
import { PLAN_LABELS } from '@/lib/plans';
import { useTheme } from '@/hooks/use-theme';
import { useLanguage } from '@/hooks/use-language';
import { THEMES } from '@/lib/themes';
import { CURRENCIES } from '@/lib/currency';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { cn } from '@/lib/utils';

import { formatTaxId } from '@/lib/br/documents';
import { RAIL_GROUPS, SECTION_META, type SettingsSection } from './settings-sections';
import { SETTINGS_HEADING } from './settings-group';
import { SettingsChip, StatusDot } from './settings-chip';
import { planStatusLabelKey } from '@/components/platform/plan-status-chip';
import { ROLE_META } from './role-meta';

interface OverviewCounts {
  members: number | null;
  pendingInvites: number | null;
  templates: number | null;
  templatesPending: number | null;
  tags: number | null;
  customFields: number | null;
}

interface WhatsAppStatus {
  configured: boolean;
  connected: boolean;
}

export function SettingsOverview({
  onSelect,
}: {
  onSelect: (section: SettingsSection) => void;
}) {
  const {
    user,
    profile,
    account,
    accountId,
    accountRole,
    defaultCurrency,
    canManageMembers,
    preferences,
  } = useAuth();
  const { mode, theme } = useTheme();
  const entitlements = useEntitlements();
  const { t } = useLanguage();

  const [counts, setCounts] = useState<OverviewCounts | null>(null);
  const [countsLoading, setCountsLoading] = useState(true);
  // WhatsApp status is tracked separately: its health check decrypts the
  // token and pings Meta, which is far slower than the cheap count
  // queries. Gating it independently keeps a slow/flaky Meta round-trip
  // from blanking the rest of the landing.
  const [whatsapp, setWhatsapp] = useState<WhatsAppStatus | null>(null);
  const [whatsappLoading, setWhatsappLoading] = useState(true);

  useEffect(() => {
    if (!user || !accountId) return;
    let cancelled = false;
    const supabase = createClient();
    const userId = user.id;
    const acctId = accountId;

    // Cheap counts — resolve fast, render immediately.
    (async () => {
      setCountsLoading(true);
      const [membersRes, invitesRes, templatesTotal, templatesPending, tagsRes, fieldsRes] =
        await Promise.allSettled([
          fetch('/api/account/members', { cache: 'no-store' }).then((r) => r.json()),
          canManageMembers
            ? fetch('/api/account/invitations', { cache: 'no-store' }).then((r) =>
                r.json(),
              )
            : Promise.resolve(null),
          supabase
            .from('message_templates')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
          supabase
            .from('message_templates')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId)
            .eq('status', 'PENDING'),
          supabase
            .from('tags')
            .select('id', { count: 'exact', head: true })
            .eq('user_id', userId),
          supabase.from('custom_fields').select('id', { count: 'exact', head: true }),
        ]);

      if (cancelled) return;

      const members =
        membersRes.status === 'fulfilled' && Array.isArray(membersRes.value?.members)
          ? membersRes.value.members.length
          : null;
      const pendingInvites =
        invitesRes.status === 'fulfilled' &&
        invitesRes.value &&
        Array.isArray(invitesRes.value.invitations)
          ? invitesRes.value.invitations.length
          : null;

      setCounts({
        members,
        pendingInvites,
        templates:
          templatesTotal.status === 'fulfilled'
            ? templatesTotal.value.count ?? null
            : null,
        templatesPending:
          templatesPending.status === 'fulfilled'
            ? templatesPending.value.count ?? null
            : null,
        tags: tagsRes.status === 'fulfilled' ? tagsRes.value.count ?? null : null,
        customFields:
          fieldsRes.status === 'fulfilled' ? fieldsRes.value.count ?? null : null,
      });
      setCountsLoading(false);
    })();

    // WhatsApp connection status — slower, independent.
    (async () => {
      setWhatsappLoading(true);
      const [row, health] = await Promise.allSettled([
        supabase
          .from('whatsapp_config')
          .select('phone_number_id')
          .eq('account_id', acctId)
          .maybeSingle(),
        fetch('/api/whatsapp/config', { cache: 'no-store' }).then((r) => r.json()),
      ]);
      if (cancelled) return;
      setWhatsapp({
        configured: row.status === 'fulfilled' && !!row.value.data?.phone_number_id,
        connected: health.status === 'fulfilled' && !!health.value?.connected,
      });
      setWhatsappLoading(false);
    })();

    return () => {
      cancelled = true;
    };
  }, [user, accountId, canManageMembers]);

  const displayName = profile?.full_name || profile?.email || t('Your account');
  const initial = (profile?.full_name || profile?.email || 'U').charAt(0).toUpperCase();
  const roleMeta = accountRole ? ROLE_META[accountRole] : null;
  const RoleIcon = roleMeta?.icon;

  const currencyLabel =
    CURRENCIES.find((c) => c.code === defaultCurrency)?.label ?? defaultCurrency;
  const themeName = THEMES.find((t) => t.id === theme)?.name ?? theme;

  // Per-tile loading + subtitle. `null` counts render as a graceful
  // fallback so a single failed query never blanks a tile.
  const tiles: {
    section: SettingsSection;
    loading: boolean;
    subtitle: ReactNode;
  }[] = [
    {
      section: 'whatsapp',
      loading: whatsappLoading,
      subtitle: !whatsapp?.configured ? (
        t('Not set up yet')
      ) : whatsapp.connected ? (
        <>
          <StatusDot tone="ok" /> {t('Connected')}
        </>
      ) : (
        <>
          <StatusDot tone="muted" /> {t('Needs reconnecting')}
        </>
      ),
    },
    {
      section: 'members',
      loading: countsLoading,
      subtitle:
        counts?.members == null
          ? t('View team members')
          : `${counts.members} ${counts.members === 1 ? t('member') : t('members')}${
              counts.pendingInvites
                ? ` · ${counts.pendingInvites} ${
                    counts.pendingInvites === 1 ? t('pending invite') : t('pending invites')
                  }`
                : ''
            }`,
    },
    {
      section: 'templates',
      loading: countsLoading,
      subtitle:
        counts?.templates == null
          ? t('Manage message templates')
          : `${counts.templates} ${counts.templates === 1 ? t('template') : t('templates')}${
              counts.templatesPending
                ? ` · ${counts.templatesPending} ${t('pending review')}`
                : ''
            }`,
    },
    {
      section: 'deals',
      loading: false,
      subtitle: `${defaultCurrency} — ${currencyLabel}`,
    },
    {
      section: 'tasks',
      loading: false,
      subtitle: t('Task statuses for the board'),
    },
    {
      section: 'quick_replies',
      loading: false,
      subtitle: t('Canned responses for the inbox'),
    },
    ...(canManageMembers
      ? [
          {
            section: 'inbox' as const,
            loading: false,
            subtitle: `${t('SLA')} ${preferences.inbox_sla_minutes} min · ${t('cooling')} ${preferences.cooling_hours} h`,
          },
          {
            section: 'support' as const,
            loading: false,
            subtitle: t('Conversation categories and triage'),
          },
          {
            section: 'integrations' as const,
            loading: false,
            subtitle: t('Lead capture by webhook'),
          },
          {
            section: 'audit' as const,
            loading: false,
            subtitle: t('Who changed what, and when'),
          },
          {
            section: 'branding' as const,
            loading: false,
            subtitle: entitlements.modules.white_label
              ? t('Your name, logo and colour')
              : t('Not included in your plan'),
          },
          {
            section: 'company' as const,
            loading: false,
            subtitle: account?.tax_id
              ? `${account.person_type === 'pj' ? 'CNPJ' : 'CPF'} ${formatTaxId(account.person_type === 'pj' ? 'pj' : 'pf', account.tax_id)}`
              : t('Add your CPF or CNPJ'),
          },
          ...(entitlements.modules.ai
            ? [
                {
                  section: 'ai' as const,
                  loading: false,
                  subtitle: t('Reply suggestions with your own AI key'),
                },
              ]
            : []),
        ]
      : []),
    {
      section: 'fields',
      loading: countsLoading,
      subtitle:
        counts?.tags == null && counts?.customFields == null
          ? t('Tags and custom fields')
          : `${counts?.tags ?? 0} ${counts?.tags === 1 ? t('tag') : t('tags')} · ${
              counts?.customFields ?? 0
            } ${counts?.customFields === 1 ? t('custom field') : t('custom fields')}`,
    },
    {
      section: 'appearance',
      loading: false,
      subtitle: `${mode === 'light' ? t('Light mode') : t('Dark mode')} · ${t('accent')} ${t(themeName)}`,
    },
    {
      section: 'notifications',
      loading: false,
      subtitle: t('Browser push notifications'),
    },
    ...(entitlements.modules.calendar
      ? [
          {
            section: 'calendar' as const,
            loading: false,
            subtitle: t('Google Calendar and Outlook sync'),
          },
        ]
      : []),
    {
      section: 'plan',
      loading: !entitlements.ready,
      subtitle: `${t(PLAN_LABELS[entitlements.plan])} · ${t(planStatusLabelKey(entitlements.status))}`,
    },
  ];

  const groups = RAIL_GROUPS.filter((g) => g.label).map(({ label, group }) => ({
    label: label as string,
    rows: tiles.filter((tile) => SECTION_META[tile.section].group === group),
  }));

  return (
    <section className="max-w-2xl">
      {/* Identity */}
      <div className="flex items-center gap-4 border-b border-border pb-5">
        <Avatar size="lg" className="size-12">
          {profile?.avatar_url ? (
            <AvatarImage src={profile.avatar_url} alt={displayName} />
          ) : null}
          <AvatarFallback className="bg-primary/10 text-lg text-primary">
            {initial}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0 flex-1">
          <div className="truncate text-base font-semibold text-foreground">
            {displayName}
          </div>
          {profile?.email ? (
            <div className="truncate text-sm text-muted-foreground">
              {profile.email}
            </div>
          ) : null}
        </div>
        {roleMeta && RoleIcon ? (
          <SettingsChip variant={roleMeta.variant}>
            <RoleIcon />
            {roleMeta.label}
          </SettingsChip>
        ) : null}
      </div>

      {groups.map(({ label, rows }) =>
        rows.length === 0 ? null : (
          <div key={label} className="mt-6">
            <h3 className={cn(SETTINGS_HEADING, 'mb-1')}>{label}</h3>
            <ul className="divide-y divide-border">
              {rows.map(({ section, loading, subtitle }) => {
                const meta = SECTION_META[section];
                const Icon = meta.icon;
                return (
                  <li key={section}>
                    <button
                      type="button"
                      onClick={() => onSelect(section)}
                      className={cn(
                        'group flex w-full items-center gap-3 rounded-md px-2 py-2.5 text-left',
                        'transition-colors duration-150 motion-reduce:transition-none hover:bg-muted/50',
                        'focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none',
                      )}
                    >
                      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                      <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-center sm:gap-3">
                        <span className="shrink-0 truncate text-sm font-medium text-foreground sm:w-44">
                          {meta.label}
                        </span>
                        <span className="flex min-w-0 items-center gap-1.5 truncate text-xs text-muted-foreground tabular-nums">
                          {loading ? (
                            <>
                              <Loader2 className="size-3 animate-spin" /> {t('Loading�')}
                            </>
                          ) : (
                            subtitle
                          )}
                        </span>
                      </span>
                      <ChevronRight
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden="true"
                      />
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ),
      )}
    </section>
  );
}
