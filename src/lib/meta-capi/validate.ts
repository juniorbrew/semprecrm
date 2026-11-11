// Input rules of the settings route. Pure (no server imports): the card also reuses the limits.
export const DATASET_ID_RE = /^[0-9]{5,30}$/
export const TEST_CODE_RE = /^[A-Za-z0-9_-]{1,40}$/
export const TOKEN_RE = /^\S{20,600}$/

export interface SettingsInput {
  dataset_id?: unknown
  token?: unknown
  test_event_code?: unknown
  send_lead?: unknown
  send_purchase?: unknown
  enabled?: unknown
}

export interface ExistingSettings {
  dataset_id: string | null
  has_token: boolean
}

export interface SettingsPatch {
  dataset_id?: string | null
  token?: string
  test_event_code?: string | null
  send_lead?: boolean
  send_purchase?: boolean
  enabled?: boolean
}

export function parseSettingsInput(
  body: SettingsInput | null,
  existing: ExistingSettings,
): { ok: true; patch: SettingsPatch } | { ok: false; error: string } {
  if (!body || typeof body !== 'object') return { ok: false, error: 'Invalid request' }
  const patch: SettingsPatch = {}

  if (body.dataset_id !== undefined) {
    const v = typeof body.dataset_id === 'string' ? body.dataset_id.trim() : ''
    if (v === '') patch.dataset_id = null
    else if (!DATASET_ID_RE.test(v)) return { ok: false, error: 'O ID do conjunto de dados deve ter só números.' }
    else patch.dataset_id = v
  }
  if (body.token !== undefined && body.token !== '') {
    if (typeof body.token !== 'string' || !TOKEN_RE.test(body.token.trim())) {
      return { ok: false, error: 'A chave de acesso parece inválida. Cole a chave inteira, sem espaços.' }
    }
    patch.token = body.token.trim()
  }
  if (body.test_event_code !== undefined) {
    const v = typeof body.test_event_code === 'string' ? body.test_event_code.trim() : ''
    if (v === '') patch.test_event_code = null
    else if (!TEST_CODE_RE.test(v)) return { ok: false, error: 'O código de teste só pode ter letras, números, - e _.' }
    else patch.test_event_code = v
  }
  for (const k of ['send_lead', 'send_purchase', 'enabled'] as const) {
    if (body[k] !== undefined) {
      if (typeof body[k] !== 'boolean') return { ok: false, error: 'Invalid request' }
      patch[k] = body[k] as boolean
    }
  }

  const datasetAfter = patch.dataset_id !== undefined ? patch.dataset_id : existing.dataset_id
  const tokenAfter = patch.token !== undefined || existing.has_token
  if (patch.enabled === true && (!datasetAfter || !tokenAfter)) {
    return { ok: false, error: 'Preencha o ID do conjunto de dados e a chave de acesso antes de ligar.' }
  }
  if (patch.enabled === undefined && (!datasetAfter || !tokenAfter) && patch.dataset_id === null) {
    patch.enabled = false // clearing the dataset turns the integration off
  }
  return { ok: true, patch }
}
