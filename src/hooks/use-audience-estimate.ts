'use client';

import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import { estimateAudience, type AudienceConfig, type AudienceEstimate } from '@/lib/broadcasts/audience';

/**
 * The broadcast wizard's audience estimate (steps 2 and 4 — one source,
 * so both show the same number). `estimate` is null while loading, when
 * the audience is incomplete, or when the lookup failed (`failed`).
 */
export function useAudienceEstimate(audience: AudienceConfig) {
  const { accountId } = useAuth();
  const [result, setResult] = useState<{
    for: AudienceConfig;
    estimate: AudienceEstimate | null;
    failed: boolean;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    estimateAudience(createClient(), audience, accountId).then(
      (estimate) => {
        if (!cancelled) setResult({ for: audience, estimate, failed: false });
      },
      (err) => {
        console.error('[broadcast] audience estimate failed:', err);
        if (!cancelled) setResult({ for: audience, estimate: null, failed: true });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [audience, accountId]);

  const current = result?.for === audience;
  return {
    estimate: current ? result.estimate : null,
    loading: !current,
    failed: current && result.failed,
  };
}
