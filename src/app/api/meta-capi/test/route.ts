import { NextResponse } from 'next/server'

import { supabaseAdmin } from '@/lib/automations/admin-client'
import { requireWritableCapiAdmin } from '@/lib/meta-capi/guard'
import { buildRequestBody, buildTestEvent } from '@/lib/meta-capi/payload'
import { sendCapiEvents } from '@/lib/meta-capi/send'
import { decrypt } from '@/lib/whatsapp/encryption'

export const dynamic = 'force-dynamic'

/** Sends one synthetic event with the saved dataset, key and test code. Needs a test code: real data stays clean. */
export async function POST() {
  const gate = await requireWritableCapiAdmin()
  if ('response' in gate) return gate.response
  const { data, error } = await supabaseAdmin()
    .from('meta_capi_settings')
    .select('dataset_id, token_enc, test_event_code')
    .eq('account_id', gate.ctx.accountId)
    .maybeSingle()
  if (error) return NextResponse.json({ error: 'Failed to load the Meta settings' }, { status: 500 })
  if (!data?.dataset_id || !data.token_enc) {
    return NextResponse.json({ ok: false, message: 'Salve o ID do conjunto de dados e a chave de acesso primeiro.' }, { status: 400 })
  }
  if (!data.test_event_code) {
    return NextResponse.json({ ok: false, message: 'Preencha o código de teste (do Gerenciador de Eventos) para não misturar com dados reais.' }, { status: 400 })
  }
  let token: string
  try {
    token = decrypt(data.token_enc as string)
  } catch {
    return NextResponse.json({ ok: false, message: 'Não foi possível ler a chave de acesso. Cole-a de novo.' }, { status: 400 })
  }
  const outcome = await sendCapiEvents({
    datasetId: data.dataset_id as string,
    token,
    body: buildRequestBody([buildTestEvent(new Date())], data.test_event_code as string),
  })
  return NextResponse.json(
    outcome.ok
      ? { ok: true, message: 'A Meta recebeu o evento de teste. Veja na aba Testar eventos do Gerenciador de Eventos.' }
      : { ok: false, message: outcome.error },
    { headers: { 'Cache-Control': 'no-store' } },
  )
}
