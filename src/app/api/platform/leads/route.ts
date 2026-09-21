import {
  authorizePlatformApi,
  leadRpcError,
  platformJson,
} from '@/lib/platform/api';
import { parseLeadQuery } from '@/lib/platform/leads';

export async function GET(request: Request) {
  try {
    const auth = await authorizePlatformApi();
    if (auth.response) return auth.response;
    let query;
    try {
      query = parseLeadQuery(new URL(request.url).searchParams);
    } catch {
      return platformJson({ error: 'Filtros ou paginação inválidos.' }, 400);
    }
    const { data, error } = await auth.supabase.rpc(
      'platform_list_leads',
      query
    );
    if (error) return leadRpcError(error);
    return platformJson(data);
  } catch {
    console.error('[platform leads] list unavailable');
    return platformJson({ error: 'Não foi possível carregar os leads.' }, 500);
  }
}
