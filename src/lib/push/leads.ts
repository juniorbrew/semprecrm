import type { SupabaseClient } from '@supabase/supabase-js';
import { isPushConfigured, sendPushToUsers, truncateBody } from './send';

interface ClaimedLead {
  id: string;
  kind: 'contato' | 'cadastro';
  name: string;
  email: string;
  company: string | null;
  notification_claim_token: string;
}

export interface LeadNotificationResult {
  claimed: number;
  notified: number;
  failed: number;
}

/**
 * One atomic claim per send: no queue of leases can expire while waiting on push.
 * The database fences completion with a random token and backs off failed attempts.
 * Durable per-subscription receipts prevent duplicates after a partial failure.
 * Web Push has no exactly-once acknowledgement: a crash after provider acceptance
 * but before receipt persistence can still repeat delivery (the stable tag collapses
 * visible notifications). Never pretend a claim is a successful delivery.
 */
export async function notifyNewLeads(
  admin: SupabaseClient
): Promise<LeadNotificationResult> {
  const result: LeadNotificationResult = { claimed: 0, notified: 0, failed: 0 };
  if (!isPushConfigured()) return result;
  const started = Date.now();
  try {
    const { data: admins, error } = await admin
      .from('platform_admins')
      .select('user_id');
    if (error) throw new Error('recipient lookup');
    const recipients = (admins ?? []).map(
      (row: { user_id: string }) => row.user_id
    );
    if (!recipients.length) return result;

    for (let i = 0; i < 10 && Date.now() - started < 35_000; i++) {
      const { data, error: claimError } = await admin.rpc(
        'claim_lead_notifications',
        { p_limit: 1 }
      );
      if (claimError) throw new Error('claim');
      const lead = (data as ClaimedLead[] | null)?.[0];
      if (!lead) break;
      result.claimed++;
      let success = false;
      try {
        const { data: receipts, error: receiptError } = await admin
          .from('lead_push_deliveries')
          .select('subscription_id')
          .eq('lead_id', lead.id);
        if (receiptError) throw new Error('receipt lookup');
        const delivered = (receipts ?? []).map(
          (row: { subscription_id: string }) => row.subscription_id
        );
        const sent = await sendPushToUsers(
          admin,
          recipients,
          {
            title: `${lead.kind === 'contato' ? 'Novo lead' : 'Novo cadastro'}: ${truncateBody(lead.name, 100)}`,
            body: lead.company || lead.email,
            url: '/platform/leads',
            tag: `lead:${lead.id}`,
          },
          {
            excludeSubscriptionIds: delivered,
            onDelivered: async (subscriptionId) => {
              const { error: saveError } = await admin
                .from('lead_push_deliveries')
                .upsert(
                  {
                    lead_id: lead.id,
                    subscription_id: subscriptionId,
                  },
                  {
                    onConflict: 'lead_id,subscription_id',
                    ignoreDuplicates: true,
                  }
                );
              if (saveError) throw new Error('receipt save');
            },
          }
        );
        success =
          sent.configured &&
          sent.failed === 0 &&
          (sent.sent > 0 || delivered.length > 0);
      } catch {
        console.error('[platform leads push] delivery failed', {
          lead_id: lead.id,
        });
      }
      const { data: completed, error: completionError } = await admin.rpc(
        'complete_lead_notification',
        {
          p_lead_id: lead.id,
          p_claim_token: lead.notification_claim_token,
          p_success: success,
        }
      );
      if (completionError || completed !== true) {
        result.failed++;
        console.error('[platform leads push] completion failed', {
          lead_id: lead.id,
        });
      } else if (success) {
        result.notified++;
      } else {
        result.failed++;
        console.warn('[platform leads push] retry scheduled', {
          lead_id: lead.id,
        });
      }
    }
  } catch {
    result.failed++;
    console.error('[platform leads push] worker unavailable');
  }
  return result;
}
