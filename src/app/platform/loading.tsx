'use client';

import { useLanguage } from '@/hooks/use-language';

export default function PlatformLoading() {
  const { t } = useLanguage();
  return (
    <div
      role="status"
      className="text-muted-foreground py-12 text-center text-sm"
    >
      {t('Loading platform data')}
    </div>
  );
}
