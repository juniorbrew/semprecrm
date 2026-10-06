'use client';

import { useLanguage } from '@/hooks/use-language';

export default function PlatformError({ reset }: { reset: () => void }) {
  const { t } = useLanguage();
  return (
    <section role="alert" className="space-y-4 py-12 text-center">
      <h1 className="text-xl font-semibold">
        {t('Could not load platform data.')}
      </h1>
      <button
        onClick={reset}
        className="bg-primary text-primary-foreground focus-visible:outline-primary min-h-10 rounded-lg px-4 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2"
      >
        {t('Try again')}
      </button>
    </section>
  );
}
