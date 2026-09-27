/**
 * Turn a Meta Graph API failure into something a person can act on.
 *
 * Meta's error envelope is precise but terse — "(#100) Unsupported get
 * request" says nothing about *which* of the four values on the settings
 * form is wrong. This module maps `code` / `error_subcode` (plus the
 * step of the connect flow that failed) onto: a plain-English summary,
 * the form field to check, and whether the fix is on the user's side
 * (HTTP 400) or Meta's (HTTP 502). The raw code, subcode and
 * `fbtrace_id` ride along so the user can quote them to Meta support.
 *
 * Pure — no I/O, no env. Ported from wacrm #505. SempreCRM addition:
 * every explanation also carries `summaryPt` (pt-BR). The sentences
 * embed ids and Meta's own text, so the DOM dictionary translator can't
 * match them — the config route returns both and the settings page
 * picks the one for the active language.
 *
 * Error codes: https://developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */

/** Which call of the connect flow failed. */
export type MetaConnectStep =
  | 'verify_number'
  | 'waba_phone_numbers'
  | 'register'
  | 'subscribe_waba'
  | 'subscribed_apps'

/** The settings-form field (or external place) the user should look at. */
export type MetaErrorField =
  | 'access_token'
  | 'phone_number_id'
  | 'waba_id'
  | 'pin'
  | 'meta_account'
  | null

/**
 * Structural shape of `MetaApiError` from ./meta-api — declared here so
 * this module stays free of I/O imports and so callers can feed it any
 * object carrying Meta's envelope fields.
 */
export interface MetaErrorLike {
  message: string
  code?: number | null
  subcode?: number | null
  type?: string | null
  fbtraceId?: string | null
  httpStatus?: number | null
  details?: string | null
}

export interface MetaErrorExplanation {
  /** Actionable, user-facing text (English). */
  summary: string
  /** The same text in pt-BR (SempreCRM's default UI language). */
  summaryPt: string
  field: MetaErrorField
  /** Who has to change something. Drives the HTTP status. */
  side: 'user' | 'meta'
  httpStatus: 400 | 502
  step: MetaConnectStep
  code: number | null
  subcode: number | null
  fbtraceId: string | null
  /** Meta's own message (with `error_data.details` appended when present). */
  metaMessage: string
}

/** Values the caller already knows — quoted back so the text names the id that failed. */
export interface MetaErrorContext {
  phoneNumberId?: string | null
  wabaId?: string | null
}

const STEP_LABEL: Record<MetaConnectStep, string> = {
  verify_number: 'reading the phone number',
  waba_phone_numbers: 'listing the phone numbers under the WhatsApp Business Account',
  register: 'registering the phone number',
  subscribe_waba: 'subscribing the WhatsApp Business Account to the app',
  subscribed_apps: 'reading the WhatsApp Business Account subscriptions',
}

const STEP_LABEL_PT: Record<MetaConnectStep, string> = {
  verify_number: 'ler o número de telefone',
  waba_phone_numbers: 'listar os números da conta do WhatsApp Business',
  register: 'registrar o número de telefone',
  subscribe_waba: 'inscrever a conta do WhatsApp Business no app',
  subscribed_apps: 'ler as inscrições da conta do WhatsApp Business',
}

const TOKEN_HINT_PT =
  'Gere um token permanente em Configurações do Negócio da Meta → Usuários do sistema → Gerar token, ' +
  'com as permissões whatsapp_business_management e whatsapp_business_messaging, ' +
  'e cole-o em Token de acesso permanente.'

const TOKEN_HINT =
  'Generate a permanent token in Meta Business Settings → System Users → Generate token, ' +
  'with the whatsapp_business_management and whatsapp_business_messaging permissions, ' +
  'and paste it into Permanent Access Token.'

const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80007, 130429, 131048, 131056])
const TEMPORARY_CODES = new Set([1, 2, 131000, 133004, 133016])

function isMetaErrorLike(err: unknown): err is MetaErrorLike {
  return (
    typeof err === 'object' &&
    err !== null &&
    typeof (err as { message?: unknown }).message === 'string' &&
    ('code' in err || 'fbtraceId' in err || 'httpStatus' in err)
  )
}

/** Which id the failing step was addressing — and the field it lives in. */
function objectForStep(
  step: MetaConnectStep,
  ctx: MetaErrorContext,
): { field: MetaErrorField; noun: string; nounPt: string; id: string | null } {
  if (step === 'verify_number' || step === 'register') {
    return {
      field: 'phone_number_id',
      noun: 'Phone Number ID',
      nounPt: 'ID do número de telefone',
      id: ctx.phoneNumberId ?? null,
    }
  }
  return {
    field: 'waba_id',
    noun: 'WhatsApp Business Account ID',
    nounPt: 'ID da conta do WhatsApp Business (WABA)',
    id: ctx.wabaId ?? null,
  }
}

function withId(noun: string, id: string | null): string {
  return id ? `${noun} ${id}` : `the ${noun}`
}

function withIdPt(noun: string, id: string | null): string {
  return id ? `o ${noun} ${id}` : `o ${noun}`
}

/**
 * Explain any error thrown while talking to Meta during the connect flow.
 * Non-Meta errors (network failures, unexpected throws) get a generic
 * Meta-side explanation so the route never has to special-case them.
 */
export function explainMetaError(
  err: unknown,
  step: MetaConnectStep,
  ctx: MetaErrorContext = {},
): MetaErrorExplanation {
  if (!isMetaErrorLike(err)) {
    const message = err instanceof Error ? err.message : String(err)
    return {
      summary:
        `Could not reach the Meta Graph API while ${STEP_LABEL[step]}: ${message}. ` +
        'Check that this server has outbound internet access to graph.facebook.com and try again.',
      summaryPt:
        `Não foi possível falar com a API Graph da Meta ao ${STEP_LABEL_PT[step]}: ${message}. ` +
        'Verifique se este servidor tem acesso de saída à internet para graph.facebook.com e tente novamente.',
      field: null,
      side: 'meta',
      httpStatus: 502,
      step,
      code: null,
      subcode: null,
      fbtraceId: null,
      metaMessage: message,
    }
  }

  const code = err.code ?? null
  const subcode = err.subcode ?? null
  const fbtraceId = err.fbtraceId ?? null
  const metaMessage = err.details ? `${err.message} (${err.details})` : err.message
  const target = objectForStep(step, ctx)

  const build = (
    summary: string,
    summaryPt: string,
    field: MetaErrorField,
    side: 'user' | 'meta',
  ): MetaErrorExplanation => ({
    summary,
    summaryPt,
    field,
    side,
    httpStatus: side === 'user' ? 400 : 502,
    step,
    code,
    subcode,
    fbtraceId,
    metaMessage,
  })

  // --- Access token -----------------------------------------------------
  if (code === 190 || (code === null && err.type === 'OAuthException')) {
    const why =
      subcode === 463
        ? 'The access token has expired.'
        : subcode === 460 || subcode === 467
          ? 'The access token has been invalidated (password change, revoked session, or token reset).'
          : 'Meta rejected the access token as invalid.'
    const whyPt =
      subcode === 463
        ? 'O token de acesso expirou.'
        : subcode === 460 || subcode === 467
          ? 'O token de acesso foi invalidado (troca de senha, sessão revogada ou token redefinido).'
          : 'A Meta recusou o token de acesso como inválido.'
    return build(
      `${why} Temporary tokens from the API Setup page expire after 24 hours. ${TOKEN_HINT}`,
      `${whyPt} Tokens temporários da página Configuração da API expiram em 24 horas. ${TOKEN_HINT_PT}`,
      'access_token',
      'user',
    )
  }

  // --- Permissions --------------------------------------------------------
  if (code === 10 || (code !== null && code >= 200 && code <= 299)) {
    return build(
      `The access token is not allowed to perform this action (${STEP_LABEL[step]}). ` +
        'Its System User needs the whatsapp_business_management and whatsapp_business_messaging ' +
        'permissions AND must be assigned to this WhatsApp Business Account ' +
        '(Business Settings → System Users → Add assets → WhatsApp accounts). Then generate a new token.',
      `O token de acesso não tem permissão para esta ação (${STEP_LABEL_PT[step]}). ` +
        'O Usuário do sistema precisa das permissões whatsapp_business_management e ' +
        'whatsapp_business_messaging E estar atribuído a esta conta do WhatsApp Business ' +
        '(Configurações do Negócio → Usuários do sistema → Adicionar ativos → Contas do WhatsApp). ' +
        'Depois gere um novo token.',
      'access_token',
      'user',
    )
  }

  if (code === 131005) {
    return build(
      `Meta denied access while ${STEP_LABEL[step]}: the business that owns the token cannot manage ` +
        `${withId(target.noun, target.id)}. Assign the System User to this WhatsApp Business Account ` +
        'in Business Settings and make sure the token has whatsapp_business_management.',
      `A Meta negou o acesso ao ${STEP_LABEL_PT[step]}: o negócio dono do token não pode gerenciar ` +
        `${withIdPt(target.nounPt, target.id)}. Atribua o Usuário do sistema a esta conta do WhatsApp ` +
        'Business nas Configurações do Negócio e confirme que o token tem whatsapp_business_management.',
      'access_token',
      'user',
    )
  }

  // --- Wrong / foreign object ids ----------------------------------------
  const looksLikeMissingObject =
    code === 33 ||
    (code === 100 && subcode === 33) ||
    (code === 100 &&
      /unsupported (get|post) request|does not exist|cannot be loaded due to missing permissions|unknown path components/i.test(
        err.message,
      ))
  if (looksLikeMissingObject) {
    return build(
      `Meta cannot find ${withId(target.noun, target.id)}, or the business that owns the access token ` +
        `does not own it. Copy the ${target.noun} exactly from Meta → WhatsApp → API Setup and check the ` +
        'token was generated inside the same Business portfolio.',
      `A Meta não encontra ${withIdPt(target.nounPt, target.id)}, ou o negócio dono do token de acesso ` +
        `não é dono dele. Copie o ${target.nounPt} exatamente de Meta → WhatsApp → Configuração da API ` +
        'e confirme que o token foi gerado no mesmo portfólio empresarial.',
      target.field,
      'user',
    )
  }

  if (code === 100) {
    if (step === 'register' && /pin/i.test(err.message)) {
      return build(
        `Meta rejected the two-step verification PIN: ${err.message}. Enter the 6-digit PIN set in ` +
          'WhatsApp Manager → Phone numbers → Two-step verification.',
        `A Meta recusou o PIN de verificação em duas etapas: ${err.message}. Informe o PIN de 6 dígitos ` +
          'definido no Gerenciador do WhatsApp → Números de telefone → Verificação em duas etapas.',
        'pin',
        'user',
      )
    }
    return build(
      `Meta rejected a parameter while ${STEP_LABEL[step]}: ${err.message}. Check that the ` +
        `${target.noun} is copied exactly (digits only, no spaces).`,
      `A Meta recusou um parâmetro ao ${STEP_LABEL_PT[step]}: ${err.message}. Confira se o ` +
        `${target.nounPt} foi copiado exatamente (só dígitos, sem espaços).`,
      target.field,
      'user',
    )
  }

  // --- Registration / PIN --------------------------------------------------
  if (code === 133010) {
    return build(
      'This phone number is not registered with the WhatsApp Cloud API yet. Enter the two-step ' +
        'verification PIN below and save again so SempreCRM can register it (POST /register).',
      'Este número ainda não está registrado na API de Nuvem do WhatsApp. Informe abaixo o PIN de ' +
        'verificação em duas etapas e salve de novo para o SempreCRM registrá-lo (POST /register).',
      'pin',
      'user',
    )
  }
  if (code === 133005 || code === 136025) {
    return build(
      'The two-step verification PIN is wrong. Use the 6-digit PIN set in WhatsApp Manager → ' +
        'Phone numbers → Two-step verification (or reset it there), then save again.',
      'O PIN de verificação em duas etapas está errado. Use o PIN de 6 dígitos definido no Gerenciador ' +
        'do WhatsApp → Números de telefone → Verificação em duas etapas (ou redefina-o lá) e salve de novo.',
      'pin',
      'user',
    )
  }
  if (code === 133008 || code === 133009) {
    return build(
      'Meta has temporarily locked PIN attempts for this number after too many wrong guesses. ' +
        'Wait a while before saving again with the correct PIN.',
      'A Meta bloqueou temporariamente as tentativas de PIN deste número após muitos erros. ' +
        'Aguarde um pouco antes de salvar de novo com o PIN correto.',
      'pin',
      'meta',
    )
  }
  if (code === 133006) {
    return build(
      'Meta requires this phone number to be re-verified. Open WhatsApp Manager → Phone numbers, ' +
        'complete verification (SMS or voice), then save again.',
      'A Meta exige que este número seja verificado de novo. Abra o Gerenciador do WhatsApp → ' +
        'Números de telefone, conclua a verificação (SMS ou voz) e salve de novo.',
      'meta_account',
      'meta',
    )
  }
  if (code === 133015) {
    return build(
      'This phone number was recently deleted from WhatsApp and cannot be registered yet. ' +
        'Meta blocks re-registration for a period after deletion — try again later.',
      'Este número foi excluído do WhatsApp recentemente e ainda não pode ser registrado. ' +
        'A Meta bloqueia o novo registro por um período após a exclusão — tente mais tarde.',
      'meta_account',
      'meta',
    )
  }

  // --- Account state ------------------------------------------------------
  if (code === 131031) {
    return build(
      'Meta has restricted or locked this WhatsApp Business Account, so nothing in SempreCRM can ' +
        'connect it. Open Meta Business Manager → Account quality (or WhatsApp Manager → Overview) ' +
        'to see the restriction and appeal it.',
      'A Meta restringiu ou bloqueou esta conta do WhatsApp Business, então nada no SempreCRM consegue ' +
        'conectá-la. Abra o Gerenciador de Negócios da Meta → Qualidade da conta (ou Gerenciador do ' +
        'WhatsApp → Visão geral) para ver a restrição e contestá-la.',
      'meta_account',
      'meta',
    )
  }
  if (code === 368) {
    return build(
      'Meta has temporarily blocked this account for a policy violation. Review the notice in ' +
        'Meta Business Manager → Account quality; the block lifts on its own or after an appeal.',
      'A Meta bloqueou temporariamente esta conta por violação de política. Veja o aviso no ' +
        'Gerenciador de Negócios da Meta → Qualidade da conta; o bloqueio cai sozinho ou após contestação.',
      'meta_account',
      'meta',
    )
  }

  // --- Throttling / transient ------------------------------------------------
  if (RATE_LIMIT_CODES.has(code ?? -1)) {
    return build(
      'Meta is rate-limiting this app or WhatsApp Business Account right now. Nothing needs ' +
        'changing — wait a few minutes and try again.',
      'A Meta está limitando a taxa de chamadas deste app ou desta conta do WhatsApp Business agora. ' +
        'Nada precisa mudar — aguarde alguns minutos e tente de novo.',
      null,
      'meta',
    )
  }
  if (TEMPORARY_CODES.has(code ?? -1)) {
    return build(
      `Meta returned a temporary error while ${STEP_LABEL[step]} (code ${code}). Retry in a minute; ` +
        'if it keeps happening, check metastatus.com and quote the trace id to Meta support.',
      `A Meta devolveu um erro temporário ao ${STEP_LABEL_PT[step]} (código ${code}). Tente de novo em ` +
        'um minuto; se continuar, consulte metastatus.com e informe o trace id ao suporte da Meta.',
      null,
      'meta',
    )
  }

  // --- Fallback: keep Meta's words -------------------------------------------
  const trace = fbtraceId ? ` Trace id ${fbtraceId}.` : ''
  const codeText = code !== null ? ` (code ${code}${subcode !== null ? `/${subcode}` : ''})` : ''
  const codeTextPt = code !== null ? ` (código ${code}${subcode !== null ? `/${subcode}` : ''})` : ''
  return build(
    `Meta returned an error while ${STEP_LABEL[step]}${codeText}: ${metaMessage}.${trace}`,
    `A Meta devolveu um erro ao ${STEP_LABEL_PT[step]}${codeTextPt}: ${metaMessage}.${trace}`,
    null,
    'meta',
  )
}

/**
 * The `meta` object POST /api/whatsapp/config attaches to every failed
 * Meta call — everything a user needs to quote to support.
 */
export function metaErrorPayload(x: MetaErrorExplanation): {
  code: number | null
  subcode: number | null
  fbtrace_id: string | null
  step: MetaConnectStep
  field: MetaErrorField
  message: string
} {
  return {
    code: x.code,
    subcode: x.subcode,
    fbtrace_id: x.fbtraceId,
    step: x.step,
    field: x.field,
    message: x.metaMessage,
  }
}
