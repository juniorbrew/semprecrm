'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  Zap,
  Plus,
  Trash2,
  MessageCircle,
  Clock,
  Users,
  PhoneCall,
  Loader2,
  Snowflake,
  Rows4,
} from 'lucide-react';

import { createClient } from '@/lib/supabase/client';
import { useCan } from '@/hooks/use-can';
import { useAuth } from '@/hooks/use-auth';
import type { Automation } from '@/types';
import { Button } from '@/components/ui/button';
import { GatedButton } from '@/components/ui/gated-button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AUTOMATION_TEMPLATES,
  type TemplateSlug,
} from '@/lib/automations/templates';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/hooks/use-language';
import { localizeAutomationTemplate } from '@/lib/automations/templates';
import { findDuplicateAutomations } from '@/lib/automations/duplicates';
import {
  AUTOMATIONS_COPY,
  AutomationListRow,
  readAutomationsDensity,
  writeAutomationsDensity,
  type AutomationsDensity,
} from '@/components/automations/automation-list-row';

const TEMPLATE_ORDER: TemplateSlug[] = [
  'welcome_message',
  'out_of_office',
  'lead_qualifier',
  'follow_up_reminder',
  'revive_cold_conversation',
];

const TEMPLATE_ICON: Record<TemplateSlug, typeof Zap> = {
  welcome_message: MessageCircle,
  out_of_office: Clock,
  lead_qualifier: Users,
  follow_up_reminder: PhoneCall,
  revive_cold_conversation: Snowflake,
};

export default function AutomationsPage() {
  const router = useRouter();
  const canCreate = useCan('send-messages');
  const { language, t } = useLanguage();
  const copy = AUTOMATIONS_COPY[language] ?? AUTOMATIONS_COPY['pt-BR'];
  const userId = useAuth().user?.id;
  const [automations, setAutomations] = useState<Automation[] | null>(null);
  const duplicates = useMemo(
    () => findDuplicateAutomations(automations ?? []),
    [automations]
  );
  const [error, setError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Automation | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Row density, per user on this device. Read after mount (localStorage
  // in the initializer would be a hydration mismatch), like the contacts list.
  const [density, setDensity] = useState<AutomationsDensity>('comfortable');
  useEffect(() => {
    if (userId) setDensity(readAutomationsDensity(userId));
  }, [userId]);
  const toggleDensity = useCallback(() => {
    setDensity((d) => {
      const next: AutomationsDensity = d === 'compact' ? 'comfortable' : 'compact';
      if (userId) writeAutomationsDensity(userId, next);
      return next;
    });
  }, [userId]);

  async function load() {
    try {
      const supabase = createClient();
      const { data, error: fetchErr } = await supabase
        .from('automations')
        .select('*')
        .order('created_at', { ascending: false });
      if (fetchErr) throw fetchErr;
      setAutomations((data ?? []) as Automation[]);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t('Failed to load automations')
      );
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function toggleActive(a: Automation, next: boolean) {
    // Optimistic flip so the switch feels instant.
    setAutomations(
      (prev) =>
        prev?.map((x) => (x.id === a.id ? { ...x, is_active: next } : x)) ??
        prev
    );
    const res = await fetch(`/api/automations/${a.id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ is_active: next }),
    });
    if (!res.ok) {
      // Roll back on error.
      setAutomations(
        (prev) =>
          prev?.map((x) => (x.id === a.id ? { ...x, is_active: !next } : x)) ??
          prev
      );
      const body = await res.json().catch(() => ({}));
      toast.error(body?.error ?? t('Failed to update'));
      return;
    }
    toast.success(t(next ? 'Automation activated' : 'Automation paused'));
  }

  async function duplicate(a: Automation) {
    const res = await fetch(`/api/automations/${a.id}/duplicate`, {
      method: 'POST',
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body?.error ?? t('Failed to duplicate'));
      return;
    }
    toast.success(t('Automation duplicated'));
    load();
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    setDeleting(true);
    const res = await fetch(`/api/automations/${pendingDelete.id}`, {
      method: 'DELETE',
    });
    setDeleting(false);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      toast.error(body?.error ?? t('Failed to delete'));
      return;
    }
    toast.success(t('Automation deleted'));
    setPendingDelete(null);
    load();
  }

  async function startFromTemplate(slug: TemplateSlug) {
    router.push(`/automations/new?template=${slug}`);
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-muted-foreground" role="alert">
          {copy.loadError} <span className="text-xs">({error})</span>
        </p>
        <Button variant="ghost" size="sm" onClick={() => window.location.reload()}>
          {copy.retry}
        </Button>
      </div>
    );
  }

  if (automations === null) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const showTemplates = automations.length < 3;

  return (
    <div className="space-y-6">
      {/* Header: title + count, one filled action */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{copy.title}</h1>
        {automations.length > 0 && (
          <span className="rounded-full bg-muted px-2 py-0.5 text-[11px] font-bold tabular-nums text-muted-foreground">
            {automations.length}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {automations.length > 0 && (
            <button
              type="button"
              onClick={toggleDensity}
              aria-pressed={density === 'compact'}
              aria-label={copy.compact}
              title={copy.compact}
              data-testid="automations-density-toggle"
              className={cn(
                'inline-flex size-7 items-center justify-center rounded-full transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none',
                density === 'compact'
                  ? 'bg-primary/10 text-primary'
                  : 'text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <Rows4 className="size-3.5" />
            </button>
          )}
          <GatedButton
            size="sm"
            canAct={canCreate}
            gateReason={t('create automations')}
            onClick={() => router.push('/automations/new')}
          >
            <Plus />
            {copy.newAutomation}
          </GatedButton>
        </div>
      </div>

      {showTemplates && (
        <section>
          <h2 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-muted-foreground">
            {copy.templates}
          </h2>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 xl:grid-cols-5">
            {TEMPLATE_ORDER.map((slug) => {
              const template = localizeAutomationTemplate(
                AUTOMATION_TEMPLATES[slug],
                language
              );
              const Icon = TEMPLATE_ICON[slug];
              return (
                <button
                  key={slug}
                  type="button"
                  onClick={() => startFromTemplate(slug)}
                  className="flex items-start gap-3 rounded-lg border border-border p-3 text-left transition-colors duration-150 hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none"
                >
                  <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-foreground">{template.name}</span>
                    <span className="mt-0.5 line-clamp-2 block text-xs text-muted-foreground">
                      {template.description}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {automations.length === 0 ? (
        <div className="py-10">
          <p className="text-sm text-foreground">{copy.empty}</p>
          <p className="mt-1 text-sm text-muted-foreground">{copy.emptyHint}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border border-y border-border">
          {automations.map((a) => (
            <AutomationListRow
              key={a.id}
              automation={a}
              language={language}
              copy={copy}
              compact={density === 'compact'}
              duplicateOf={duplicates.get(a.id) ?? []}
              onToggle={(next) => toggleActive(a, next)}
              onEdit={() => router.push(`/automations/${a.id}/edit`)}
              onDuplicate={() => duplicate(a)}
              onLogs={() => router.push(`/automations/${a.id}/logs`)}
              onDelete={() => setPendingDelete(a)}
            />
          ))}
        </ul>
      )}

      <Dialog
        open={!!pendingDelete}
        onOpenChange={(v) => !v && setPendingDelete(null)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('Delete automation')}</DialogTitle>
            <DialogDescription>
              {t('This permanently removes')}{' '}
              <span className="text-foreground">{pendingDelete?.name}</span>{' '}
              {t('and its execution history. This cannot be undone.')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setPendingDelete(null)}
              disabled={deleting}
            >
              {t('Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={confirmDelete}
              disabled={deleting}
            >
              {deleting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Trash2 className="h-4 w-4" />
              )}
              {t('Delete')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
