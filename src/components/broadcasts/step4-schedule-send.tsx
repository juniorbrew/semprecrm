'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { ArrowLeft, Send, Loader2, Save } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { useLanguage } from '@/hooks/use-language';
import { templateLanguageLabel } from './template-language-label';
import { SECTION_TITLE, StepFooter, StepHeader } from './wizard-ui';

interface AudienceConfig {
  type: string;
  tagIds?: string[];
  csvContacts?: { phone: string; name?: string }[];
}

interface Step4Props {
  name: string;
  onNameChange: (name: string) => void;
  template: MessageTemplate;
  audience: AudienceConfig;
  onSend: () => void;
  onSaveDraft?: () => void;
  onBack: () => void;
  isProcessing: boolean;
  progress: number;
}

export function Step4ScheduleSend({
  name,
  onNameChange,
  template,
  audience,
  onSend,
  onSaveDraft,
  onBack,
  isProcessing,
  progress,
}: Step4Props) {
  const { t, language } = useLanguage();
  const [showConfirm, setShowConfirm] = useState(false);
  const [estimatedReach, setEstimatedReach] = useState<number>(0);
  const [loadingReach, setLoadingReach] = useState(true);

  useEffect(() => {
    async function calculateReach() {
      setLoadingReach(true);
      try {
        const supabase = createClient();

        if (audience.type === 'all') {
          const { count } = await supabase
            .from('contacts')
            .select('*', { count: 'exact', head: true });
          setEstimatedReach(count ?? 0);
        } else if (audience.type === 'tags' && audience.tagIds && audience.tagIds.length > 0) {
          const { data: contactTags } = await supabase
            .from('contact_tags')
            .select('contact_id')
            .in('tag_id', audience.tagIds);

          const uniqueIds = new Set((contactTags ?? []).map((ct) => ct.contact_id));
          setEstimatedReach(uniqueIds.size);
        } else if (audience.type === 'csv' && audience.csvContacts) {
          setEstimatedReach(audience.csvContacts.length);
        } else {
          setEstimatedReach(0);
        }
      } finally {
        setLoadingReach(false);
      }
    }

    calculateReach();
  }, [audience]);

  const audienceLabel =
    audience.type === 'all'
      ? t('All Contacts')
      : audience.type === 'tags'
        ? `${t('Tags')} (${audience.tagIds?.length ?? 0} ${t('selected')})`
        : audience.type === 'csv'
          ? t('CSV Upload')
          : t('Custom Field');

  const summary: { label: string; value: React.ReactNode; noTranslate?: boolean }[] = [
    { label: t('Template'), value: template.name },
    { label: t('Audience'), value: audienceLabel },
    {
      label: t('Estimated Reach'),
      value: loadingReach ? (
        <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-label={t('Calculating…')} />
      ) : (
        <span className="font-semibold tabular-nums">{estimatedReach.toLocaleString(language)}</span>
      ),
    },
    { label: t('Language'), value: templateLanguageLabel(template.language, language), noTranslate: true },
  ];

  return (
    <div className="space-y-6">
      <StepHeader title={t('Review & Send')} description={t('Name the broadcast, review the details and send.')} />

      {/* Broadcast Name */}
      <div className="max-w-2xl space-y-1.5">
        <Label htmlFor="broadcast-name">{t('Broadcast Name')}</Label>
        <Input
          id="broadcast-name"
          value={name}
          onChange={(e) => onNameChange(e.target.value)}
          placeholder={t('e.g. Summer Sale Announcement')}
        />
      </div>

      {/* Summary — hairline rows, no box */}
      <section className="space-y-1">
        <h3 className={SECTION_TITLE}>{t('Summary')}</h3>
        <dl className="divide-y divide-border border-y border-border text-sm">
          {summary.map((row) => (
            <div key={row.label} className="flex items-center justify-between gap-4 py-2">
              <dt className="text-muted-foreground">{row.label}</dt>
              <dd className="min-w-0 truncate text-right text-foreground" data-no-translate={row.noTranslate || undefined}>
                {row.value}
              </dd>
            </div>
          ))}
        </dl>
      </section>

      {/* Send progress — a thin line, not a box */}
      {isProcessing && (
        <section className="space-y-1.5" aria-live="polite">
          <p className="flex items-center justify-between text-sm text-foreground">
            <span className="inline-flex items-center gap-2">
              <Loader2 className="size-3.5 animate-spin text-muted-foreground" aria-hidden />
              {t('Sending broadcast...')}
            </span>
            <span className="text-xs tabular-nums text-muted-foreground">{progress}%</span>
          </p>
          <div
            role="progressbar"
            aria-valuenow={progress}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={t('Sending broadcast...')}
            className="h-1 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-200 motion-reduce:transition-none"
              style={{ width: `${progress}%` }}
            />
          </div>
        </section>
      )}

      <StepFooter>
        <Button
          variant="ghost"
          onClick={onBack}
          disabled={isProcessing}
          className="text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft />
          {t('Back')}
        </Button>

        <div className="flex items-center gap-2">
          {onSaveDraft && (
            <Button variant="ghost" onClick={onSaveDraft} disabled={!name.trim() || isProcessing}>
              <Save />
              {t('Save as draft')}
            </Button>
          )}

          <Dialog open={showConfirm} onOpenChange={setShowConfirm}>
            <DialogTrigger render={<Button disabled={!name.trim() || isProcessing} />}>
              <Send />
              {t('Send Broadcast')}
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">{t('Confirm broadcast')}</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {t('You are about to send this broadcast to')}{' '}
                  <span className="font-medium text-popover-foreground">
                    {estimatedReach.toLocaleString(language)}
                  </span>{' '}
                  {t('contacts using the template')}{' '}
                  <span className="font-medium text-popover-foreground">{template.name}</span>.{' '}
                  {t('This action cannot be undone.')}
                </DialogDescription>
              </DialogHeader>
              <DialogFooter>
                <Button variant="outline" onClick={() => setShowConfirm(false)}>
                  {t('Cancel')}
                </Button>
                <Button
                  onClick={() => {
                    setShowConfirm(false);
                    onSend();
                  }}
                >
                  <Send />
                  {t('Confirm & Send')}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </StepFooter>
    </div>
  );
}
