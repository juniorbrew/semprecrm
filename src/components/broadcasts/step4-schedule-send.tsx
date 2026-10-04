'use client';

import { useState } from 'react';
import { MessageTemplate } from '@/types';
import type { AudienceConfig } from '@/lib/broadcasts/audience';
import { useAudienceEstimate } from '@/hooks/use-audience-estimate';
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
import { AudienceBreakdownLine, SECTION_TITLE, StepFooter, StepHeader } from './wizard-ui';

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
  // Same estimate as step 2 and the same rules the send applies.
  // No valid estimate (loading or failed) → "—" and no send: never "send to 0".
  const { estimate, loading: loadingReach } = useAudienceEstimate(audience);
  const reach = estimate
    ? `${estimate.suppressionChecked ? '' : `${t('up to')} `}${estimate.breakdown.eligible.toLocaleString(language)}`
    : '—';
  const canSend = !!name.trim() && !isProcessing && !!estimate;

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
        <span className="font-semibold tabular-nums">{reach}</span>
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
        {estimate ? (
          <AudienceBreakdownLine estimate={estimate} t={t} language={language} />
        ) : (
          !loadingReach && (
            <p role="alert" className="text-xs text-destructive">
              {t('Could not calculate the reach. Try again.')}
            </p>
          )
        )}
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
            <DialogTrigger render={<Button disabled={!canSend} />}>
              <Send />
              {t('Send Broadcast')}
            </DialogTrigger>
            <DialogContent className="border-border bg-popover sm:max-w-md">
              <DialogHeader>
                <DialogTitle className="text-popover-foreground">{t('Confirm broadcast')}</DialogTitle>
                <DialogDescription className="text-muted-foreground">
                  {t('You are about to send this broadcast to')}{' '}
                  <span className="font-medium text-popover-foreground">{reach}</span>{' '}
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
                  disabled={!canSend}
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
