import {
  authorizePlatformApi,
  leadRpcError,
  platformJson,
} from '@/lib/platform/api';
import { isLeadStatus } from '@/lib/platform/leads';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Read at most 1KiB even when Content-Length is missing or forged. */
async function readPatch(request: Request): Promise<unknown> {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 1024) {
        await reader.cancel();
        throw new RangeError('Payload too large');
      }
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally {
    reader.releaseLock();
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const auth = await authorizePlatformApi();
    if (auth.response) return auth.response;
    // Cookie-authenticated mutations must not accept a cross-origin browser request.
    const origin = request.headers.get('origin');
    if (origin && origin !== new URL(request.url).origin) {
      return platformJson({ error: 'Origem inválida.' }, 403);
    }
    const { id } = await params;
    if (!UUID_RE.test(id))
      return platformJson({ error: 'Identificador inválido.' }, 400);
    let body: unknown;
    try {
      body = await readPatch(request);
    } catch (error) {
      return platformJson(
        { error: 'Corpo da requisição inválido.' },
        error instanceof RangeError ? 413 : 400
      );
    }
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('status' in body) ||
      !isLeadStatus(body.status)
    ) {
      return platformJson({ error: 'Informe apenas um status válido.' }, 400);
    }
    const { data, error } = await auth.supabase.rpc(
      'platform_update_lead_status',
      {
        p_lead_id: id,
        p_status: body.status,
      }
    );
    if (error) return leadRpcError(error);
    return platformJson({ lead: data });
  } catch {
    console.error('[platform leads] update unavailable');
    return platformJson({ error: 'Não foi possível atualizar o lead.' }, 500);
  }
}
