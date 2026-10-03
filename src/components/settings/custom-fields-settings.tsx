'use client';

import { Shield } from 'lucide-react';

import { CustomFieldsPanel } from '@/components/contacts/custom-fields-manager';
import { useLanguage } from '@/hooks/use-language';
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
      <CustomFieldsPanel />
    </SettingsGroup>
  );
}
