'use client';

import { Button } from '@/components/ui/button';

export default function LeadsError({ reset }: { reset: () => void }) {
  return (
    <div role="alert" className="border-destructive/30 rounded-xl border p-6">
      <p className="mb-3">Não foi possível carregar os leads.</p>
      <Button variant="outline" onClick={reset}>
        Tentar novamente
      </Button>
    </div>
  );
}
