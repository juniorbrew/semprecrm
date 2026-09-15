'use client';

import { useEffect, useState } from 'react';
import { Download, Loader2, ShieldCheck, UserX } from 'lucide-react';
import { toast } from 'sonner';

import { createClient } from '@/lib/supabase/client';
import { useCan } from '@/hooks/use-can';
import { useLanguage } from '@/hooks/use-language';
import type { ConsentStatus, Contact } from '@/types';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * LGPD block shared by the inbox contact panel (compact) and the
 * contacts page detail sheet: consent select, "Export data" (admin+),
 * "Anonymize" (admin+, dialog that requires typing the contact name).
 *
 * The parent owns the contact; `onChanged` fires after a consent
 * change or a completed anonymisation so it can refetch.
 */
export interface ContactPrivacySectionProps {
  contact: Pick<
    Contact,
    'id' | 'name' | 'phone' | 'consent_status' | 'consent_updated_at' | 'anonymized_at'
  >;
  /** Tighter spacing and smaller controls for the inbox side panel. */
  compact?: boolean;
  onChanged?: () => void;
  className?: string;
}

const CONSENT_OPTIONS: { value: ConsentStatus; label: string }[] = [
  { value: 'unknown', label: 'Not recorded' },
  { value: 'granted', label: 'Consent granted' },
  { value: 'revoked', label: 'Consent revoked' },
];

export const CONSENT_LABELS: Record<ConsentStatus, string> = {
  unknown: 'Not recorded',
  granted: 'Consent granted',
  revoked: 'Consent revoked',
};

export function ContactPrivacySection({
  contact,
  compact = false,
  onChanged,
  className,
}: ContactPrivacySectionProps) {
  const { t, language } = useLanguage();
  const canWrite = useCan('send-messages');
  const canAdmin = useCan('edit-settings');

  const anonymized = !!contact.anonymized_at;
  const [consent, setConsent] = useState<ConsentStatus>(contact.consent_status ?? 'unknown');
  const [savingConsent, setSavingConsent] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [anonymizing, setAnonymizing] = useState(false);

  useEffect(() => {
    setConsent(contact.consent_status ?? 'unknown');
  }, [contact.id, contact.consent_status]);

  const expectedName = (contact.name?.trim() || contact.phone || '').trim();

  async function changeConsent(next: ConsentStatus) {
    if (next === consent || savingConsent) return;
    const previous = consent;
    setConsent(next);
    setSavingConsent(true);
    try {
      const supabase = createClient();
      const { error } = await supabase
        .from('contacts')
        .update({ consent_status: next, updated_at: new Date().toISOString() })
        .eq('id', contact.id);
      if (error) throw error;
      toast.success(t('Consent updated'));
      onChanged?.();
    } catch (err) {
      console.error('[privacy] consent update failed:', err);
      setConsent(previous);
      toast.error(t('Could not update consent'));
    } finally {
      setSavingConsent(false);
    }
  }

  async function exportData() {
    if (exporting) return;
    setExporting(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/export`, { cache: 'no-store' });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `contato-${contact.id}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast.success(t('Contact data exported'));
    } catch (err) {
      console.error('[privacy] export failed:', err);
      toast.error(t('Could not export contact data'));
    } finally {
      setExporting(false);
    }
  }

  async function anonymize() {
    if (anonymizing || confirm.trim() !== expectedName) return;
    setAnonymizing(true);
    try {
      const res = await fetch(`/api/contacts/${contact.id}/anonymize`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirm: confirm.trim() }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(body?.error ?? `HTTP ${res.status}`);
      }
      toast.success(t('Contact anonymized'));
      setDialogOpen(false);
      setConfirm('');
      onChanged?.();
    } catch (err) {
      console.error('[privacy] anonymize failed:', err);
      toast.error(t('Could not anonymize the contact'));
    } finally {
      setAnonymizing(false);
    }
  }

  const consentUpdated = contact.consent_updated_at
    ? new Date(contact.consent_updated_at).toLocaleDateString(language)
    : null;

  return (
    <div className={cn(compact ? 'space-y-2 px-1' : 'space-y-3', className)} data-privacy-section>
      {anonymized ? (
        <div
          className={cn(
            'rounded-lg border border-dashed border-border bg-muted/40 text-muted-foreground',
            compact ? 'px-3 py-2 text-xs' : 'px-3 py-2.5 text-sm',
          )}
        >
          {t('Personal data was removed on')}{' '}
          {new Date(contact.anonymized_at as string).toLocaleDateString(language)}.{' '}
          {t('Editing and messaging are blocked for this contact.')}
        </div>
      ) : (
        <>
          <div className={cn('flex items-center gap-2', compact ? 'text-xs' : 'text-sm')}>
            <ShieldCheck
              className={cn('shrink-0 text-muted-foreground', compact ? 'size-3.5' : 'size-4')}
            />
            <label className="sr-only" htmlFor={`consent-${contact.id}`}>
              {t('Consent')}
            </label>
            <select
              id={`consent-${contact.id}`}
              aria-label={t('Consent')}
              className={cn(
                'min-w-0 flex-1 rounded-md border border-border bg-muted px-2 text-foreground focus:border-primary focus:outline-none disabled:opacity-60',
                compact ? 'h-7 text-xs' : 'h-8 text-sm',
              )}
              value={consent}
              disabled={!canWrite || savingConsent}
              onChange={(e) => void changeConsent(e.target.value as ConsentStatus)}
            >
              {CONSENT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {t(o.label)}
                </option>
              ))}
            </select>
            {savingConsent && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
          </div>
          {consentUpdated && (
            <p className="text-[10px] text-muted-foreground">
              {t('Updated on')} {consentUpdated}
            </p>
          )}
        </>
      )}

      {canAdmin && (
        <div className={cn('flex flex-wrap gap-2', compact && 'gap-1.5')}>
          <Button
            type="button"
            variant="outline"
            size={compact ? 'xs' : 'sm'}
            onClick={() => void exportData()}
            disabled={exporting}
            className="gap-1.5"
          >
            {exporting ? (
              <Loader2 className="size-3.5 animate-spin" />
            ) : (
              <Download className="size-3.5" />
            )}
            {t('Export data')}
          </Button>
          {!anonymized && (
            <Button
              type="button"
              variant="outline"
              size={compact ? 'xs' : 'sm'}
              onClick={() => setDialogOpen(true)}
              className="gap-1.5 text-destructive hover:bg-destructive/10 hover:text-destructive"
            >
              <UserX className="size-3.5" />
              {t('Anonymize')}
            </Button>
          )}
        </div>
      )}

      <Dialog
        open={dialogOpen}
        onOpenChange={(open) => {
          if (anonymizing) return;
          setDialogOpen(open);
          if (!open) setConfirm('');
        }}
      >
        <DialogContent className="border-border bg-popover sm:max-w-md">
          <DialogHeader>
            <DialogTitle className="text-popover-foreground">{t('Anonymize contact?')}</DialogTitle>
            <DialogDescription className="text-muted-foreground">
              {t(
                'This permanently removes name, phone, email, company, custom fields, notes, message contents and media. Conversations, deals and tasks stay for statistics. This cannot be undone.',
              )}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`anon-confirm-${contact.id}`} className="text-xs text-muted-foreground">
              {t('Type the contact name to confirm')}:{' '}
              <span className="font-medium text-foreground">{expectedName}</span>
            </Label>
            <Input
              id={`anon-confirm-${contact.id}`}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              placeholder={expectedName}
              autoComplete="off"
              className="bg-muted border-border text-foreground"
              disabled={anonymizing}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setDialogOpen(false)}
              disabled={anonymizing}
            >
              {t('Cancel')}
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => void anonymize()}
              disabled={anonymizing || confirm.trim() !== expectedName}
              className="gap-1.5"
            >
              {anonymizing ? <Loader2 className="size-3.5 animate-spin" /> : <UserX className="size-3.5" />}
              {t('Anonymize')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
