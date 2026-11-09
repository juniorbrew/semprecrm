'use client';

import { Shield } from 'lucide-react';

import { CustomFieldsPanel } from '@/components/contacts/custom-fields-manager';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useEntitlements } from '@/hooks/use-auth';
import { useLanguage } from '@/hooks/use-language';
import { DealFieldsSettings } from './deal-fields-settings';
import { SettingsChip } from './settings-chip';
import { SettingsGroup } from './settings-group';

/**
 * Settings → Custom Fields group. Manages the account-wide custom
 * contact field catalogue (the same panel the Contacts page exposes
 * via a dialog). Writes are admin-gated by the caller and enforced by
 * `custom_fields` RLS.
 */
export function CustomFieldsSettings() {
  const { t } = useLanguage();
  // Deal fields belong to the pipelines module: without it only the contact fields exist.
  const { ready, modules } = useEntitlements();
  const dealFields = ready && modules.pipelines;
  return (
    <SettingsGroup
      title={
        <>
          {t('Custom fields')}
          <SettingsChip variant="admin" className="font-medium normal-case tracking-normal">
            <Shield />
            {t('Admin')}
          </SettingsChip>
        </>
      }
      description={
        <>
          Extra contact fields (e.g. ZIP code, lead source). They appear on
          every contact and in the “Update Contact Field” automation action.
        </>
      }
    >
      {dealFields ? (
        <Tabs defaultValue="contact">
          <TabsList>
            <TabsTrigger value="contact">{t('Contact fields')}</TabsTrigger>
            <TabsTrigger value="deal">{t('Deal fields')}</TabsTrigger>
          </TabsList>
          <TabsContent value="contact" className="pt-3">
            <CustomFieldsPanel />
          </TabsContent>
          <TabsContent value="deal" className="pt-3">
            <DealFieldsSettings />
          </TabsContent>
        </Tabs>
      ) : (
        <CustomFieldsPanel />
      )}
    </SettingsGroup>
  );
}
