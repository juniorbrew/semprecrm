import { describe, expect, it } from 'vitest';

import { abandonUnstartedBroadcast } from './broadcast-abandon';
import { FakeDb } from './whatsapp/fake-supabase.testkit';

// Round-3 review: when POST /start fails, the wizard must not leave an
// empty campaign sitting in "Enviando".

function seed(recipients: number, lock: string | null = null): FakeDb {
  const db = new FakeDb();
  db.seed('broadcasts', [{ id: 'bc-1', status: 'sending', delivery_locked_at: lock }]);
  db.seed(
    'broadcast_recipients',
    Array.from({ length: recipients }, (_, i) => ({ id: `r${i}`, broadcast_id: 'bc-1', status: 'pending' })),
  );
  return db;
}

describe('abandonUnstartedBroadcast', () => {
  it('deletes a campaign that has no recipients yet', async () => {
    const db = seed(0);
    expect(await abandonUnstartedBroadcast(db.client(), 'bc-1')).toBe('deleted');
    expect(db.table('broadcasts')).toEqual([]);
  });

  it('marks a campaign with recipients failed instead of deleting it', async () => {
    const db = seed(2);
    expect(await abandonUnstartedBroadcast(db.client(), 'bc-1')).toBe('failed');
    expect(db.table('broadcasts')[0].status).toBe('failed');
    expect(db.table('broadcast_recipients')).toHaveLength(2);
  });

  it('never touches the status of a campaign another pass holds the lock of', async () => {
    const db = seed(1, '2026-09-27T12:00:00.000123Z');
    await abandonUnstartedBroadcast(db.client(), 'bc-1');
    expect(db.table('broadcasts')[0].status).toBe('sending');
  });
});
