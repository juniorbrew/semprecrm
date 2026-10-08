import { authorizePlatformApi, platformJson } from '@/lib/platform/api';
import { supabaseAdmin } from '@/lib/automations/admin-client';
import { isPlan } from '@/lib/plans';
import { loadPlanVersionHistory } from '@/lib/plan-catalog-server';
export async function GET(
  request: Request,
  { params }: { params: Promise<{ plan: string }> }
) {
  const auth = await authorizePlatformApi();
  if (auth.response) return auth.response;
  const { plan } = await params;
  const cursor = new URL(request.url).searchParams.get('cursor');
  if (
    !isPlan(plan) ||
    (cursor !== null &&
      (!/^[1-9]\d*$/.test(cursor) || !Number.isSafeInteger(Number(cursor))))
  )
    return platformJson({ error: 'Filtro inválido.' }, 400);
  try {
    return platformJson(
      await loadPlanVersionHistory(supabaseAdmin(), plan, cursor)
    );
  } catch {
    return platformJson(
      { error: 'Não foi possível carregar o histórico.' },
      503
    );
  }
}
