import { revalidatePath } from 'next/cache';
import { authorizePlatformApi, platformJson } from '@/lib/platform/api';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { isPlan } from '@/lib/plans';
import { isVersionId, parsePlanVersion } from '@/lib/plan-catalog';
import { loadCurrentPlanCatalog } from '@/lib/plan-catalog-server';

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ plan: string }> }
) {
  const auth = await authorizePlatformApi();
  if (auth.response) return auth.response;
  const { plan } = await params;
  if (!isPlan(plan)) return platformJson({ error: 'Plano inválido.' }, 400);
  try {
    return platformJson({
      plan: (await loadCurrentPlanCatalog(auth.supabase)).find(
        (v) => v.plan === plan
      ),
    });
  } catch {
    return platformJson(
      { error: 'Catálogo indisponível. Tente novamente.' },
      503
    );
  }
}
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ plan: string }> }
) {
  const auth = await authorizePlatformApi();
  if (auth.response) return auth.response;
  const { plan } = await params;
  const body: unknown = await request.json().catch(() => null);
  if (!isPlan(plan) || !body || typeof body !== 'object' || Array.isArray(body))
    return platformJson({ error: 'Dados inválidos.' }, 400);
  const input = body as Record<string, unknown>;
  const parsed = parsePlanVersion({
    id: input.expected_version_id,
    plan,
    revision: 1,
    definition: input.definition,
    price_monthly_cents: input.price_monthly_cents,
  });
  if (
    !parsed ||
    !isVersionId(input.expected_version_id) ||
    Object.keys(input).some(
      (key) =>
        !['expected_version_id', 'definition', 'price_monthly_cents'].includes(
          key
        )
    )
  )
    return platformJson({ error: 'Dados inválidos.' }, 400);
  const { data, error } = await supabaseAdmin().rpc(
    'platform_save_plan_version',
    {
      p_plan: plan,
      p_expected_version_id: parsed.id,
      p_definition: parsed.definition,
      p_price_monthly_cents: parsed.price_monthly_cents,
      p_actor_user_id: auth.user.id,
    }
  );
  if (error) {
    if (error.code === '40001')
      return platformJson(
        {
          error:
            'O plano foi alterado por outra pessoa. Recarregue as condições atuais antes de salvar.',
        },
        409
      );
    return platformJson(
      { error: 'Não foi possível salvar o plano.' },
      error.code === '22023' ? 400 : error.code === '42501' ? 403 : 500
    );
  }
  const saved = parsePlanVersion(Array.isArray(data) ? data[0] : data);
  if (!saved || saved.plan !== plan)
    return platformJson(
      { error: 'Não foi possível confirmar o salvamento. Recarregue o plano.' },
      500
    );
  revalidatePath('/precos');
  return platformJson({ plan: saved });
}
