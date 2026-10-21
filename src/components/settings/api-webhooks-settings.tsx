'use client';

import { useCan } from '@/hooks/use-can';
import { useAuth } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';

import { ApiKeysGroup } from './api-keys-group';
import { SettingsPanelHead } from './settings-panel-head';
import { WebhookEndpointsGroup } from './webhook-endpoints-group';

/**
 * Configurações → API e Webhooks. Admin+ only: API keys and signing
 * secrets are credentials (the routes enforce the same with requireRole).
 */
export function ApiWebhooksSettings() {
  const { t } = useLanguage();
  const { profileLoading } = useAuth();
  const canAdmin = useCan('manage-members');

  if (profileLoading) {
    return (
      <section className="max-w-3xl">
        <SettingsPanelHead title={t('API and Webhooks')} />
        <div className="h-12 animate-pulse rounded-lg bg-muted/60" />
      </section>
    );
  }
  if (!canAdmin) {
    return (
      <section className="max-w-3xl">
        <SettingsPanelHead title={t('API and Webhooks')} />
        <div role="note">
          <p className="text-sm font-medium text-foreground">{t('Admins only')}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t('Only account admins can manage API keys and webhooks, because they are credentials.')}
          </p>
        </div>
      </section>
    );
  }
  return (
    <section className="max-w-3xl">
      <SettingsPanelHead
        title={t('API and Webhooks')}
        description={t(
          'Connect n8n, Zapier or your own systems: send messages with the API and receive events as they happen. Documentation: docs/api-webhooks.md.',
        )}
      />
      <div className="space-y-8">
        <ApiKeysGroup />
        <WebhookEndpointsGroup />
      </div>
    </section>
  );
}
