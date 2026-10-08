import { authorizePlatformApi, platformJson } from '@/lib/platform/api';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { isVersionId } from '@/lib/plan-catalog';
import { getPlatformAccount } from '@/lib/platform/server';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ accountId: string }> }
) {
  const auth = await authorizePlatformApi();
  if (auth.response) return auth.response;
  const { accountId } = await params;
  const body: unknown = await request.json().catch(() => null);
  if (
    !isVersionId(accountId) ||
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body)
  )
    return platformJson({ error: 'Dados inválidos.' }, 400);
  const {
    adopt_current_plan = false,
    expected_plan_version_id = null,
    ...patch
  } = body as Record<string, unknown>;
  if (
    typeof adopt_current_plan !== 'boolean' ||
    (expected_plan_version_id !== null &&
      !isVersionId(expected_plan_version_id)) ||
    Object.keys(patch).some(
      (key) =>
        ![
          'plan',
          'plan_status',
          'plan_expires_at',
          'module_overrides',
          'limit_overrides',
          'platform_notes',
        ].includes(key)
    )
  )
    return platformJson({ error: 'Dados inválidos.' }, 400);
  const { error } = await supabaseAdmin().rpc('platform_update_account_v2', {
    p_account_id: accountId,
    p_patch: patch,
    p_actor_user_id: auth.user.id,
    p_expected_version_id: expected_plan_version_id,
    p_adopt_current: adopt_current_plan,
  });
  if (error)
    return platformJson(
      {
        error:
          error.code === '40001'
            ? 'O plano mudou. Recarregue as condições atuais antes de salvar.'
            : 'Não foi possível atualizar a empresa.',
      },
      error.code === '40001'
        ? 409
        : error.code === '22023' || error.code === '22P02'
          ? 400
          : error.code === '42501'
            ? 403
            : 500
    );
  try {
    const account = await getPlatformAccount(auth.supabase, accountId);
    if (!account) throw new Error('Missing updated account');
    return platformJson({ account });
  } catch {
    return platformJson(
      {
        error:
          'Alteração salva, mas não foi possível atualizar o resumo. Recarregue a empresa.',
      },
      503
    );
  }
}
