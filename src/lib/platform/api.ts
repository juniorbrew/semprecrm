import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';

export function platformJson(body: unknown, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: { 'Cache-Control': 'private, no-store' },
  });
}

export async function authorizePlatformApi() {
  const supabase = await createClient();
  const {
    data: { user },
    error,
  } = await supabase.auth.getUser();
  if (error || !user)
    return { response: platformJson({ error: 'Não autorizado.' }, 401) };
  const { data, error: adminError } = await supabase.rpc('is_platform_admin');
  if (adminError) {
    console.error('[platform leads] authorization failed', {
      code: adminError.code,
    });
    return {
      response: platformJson(
        { error: 'Não foi possível verificar o acesso.' },
        503
      ),
    };
  }
  if (data !== true)
    return { response: platformJson({ error: 'Acesso negado.' }, 403) };
  return { supabase };
}

export function leadRpcError(error: { code: string }) {
  if (error.code === '42501')
    return platformJson({ error: 'Acesso negado.' }, 403);
  if (error.code === '22023' || error.code === '22P02')
    return platformJson({ error: 'Dados inválidos.' }, 400);
  if (error.code === 'P0002')
    return platformJson({ error: 'Lead não encontrado.' }, 404);
  console.error('[platform leads] operation failed', { code: error.code });
  return platformJson({ error: 'Não foi possível concluir a operação.' }, 500);
}
