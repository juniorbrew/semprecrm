'use client';

import { Smartphone, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useInstallPrompt } from '@/hooks/use-install-prompt';
import { useLanguage } from '@/hooks/use-language';

/**
 * Phone-only invitation to install SempreCRM on the home screen. Android
 * gets a one-tap button (the browser's own install dialog); iPhone gets
 * the Share → "Adicionar à Tela de Início" steps, since iOS has no install
 * API and only delivers notifications to the installed app. Hidden once
 * installed or dismissed.
 */
export function InstallAppBanner() {
  const { t } = useLanguage();
  const { standalone, ios, dismissed, canInstall, install, dismiss } = useInstallPrompt();
  if (standalone || dismissed || !(canInstall || ios)) return null;
  return (
    <div
      role="status"
      className="flex items-center gap-3 border-b border-primary/20 bg-primary/5 px-4 py-2.5 text-sm text-foreground md:hidden"
    >
      <Smartphone className="size-4 shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        <span className="font-medium">{t('Install SempreCRM on your phone.')}</span>{' '}
        {ios
          ? t('Tap Share, then "Add to Home Screen". On iPhone, notifications only arrive in the installed app.')
          : t('It opens full screen, like an app, and receives notifications.')}
      </p>
      {canInstall ? (
        <Button size="sm" onClick={() => void install()}>
          {t('Install')}
        </Button>
      ) : null}
      <Button variant="ghost" size="icon-sm" onClick={dismiss} aria-label={t('Dismiss')}>
        <X className="size-4" aria-hidden="true" />
      </Button>
    </div>
  );
}
