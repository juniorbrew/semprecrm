/** pt-BR copy for the "auth" area — EN key → pt-BR. Loaded through ./index.ts. */
export const DICT_AUTH: Record<string, string> = {
  // ---- Login / signup / forgot-password pages ----
  'you@example.com': 'voce@exemplo.com',
  'John Doe': 'João da Silva',
  'Get started with the WhatsApp CRM': 'Comece a usar o CRM para WhatsApp',
  'Confirm your e-mail and accept the invite to join the team.':
    'Confirme seu e-mail e aceite o convite para entrar na equipe.',
  'Person in charge': 'Nome do responsável',
  'Company contact and address': 'Contato e endereço da empresa',
  'We sent a confirmation link to': 'Enviamos um link de confirmação para',
  '. Check your inbox and click the link to confirm your account.':
    '. Verifique sua caixa de entrada e clique no link para confirmar sua conta.',
  'We sent a password reset link to': 'Enviamos um link de recuperação de senha para',
  '. Check your inbox.': '. Verifique sua caixa de entrada.',
  "Enter your e-mail and we'll send you a reset link":
    'Digite seu e-mail e enviaremos um link de recuperação',

  // ---- Supabase Auth errors, mapped in src/app/(auth)/_lib/auth-errors.ts ----
  'Incorrect e-mail or password. Check the details and try again.':
    'E-mail ou senha incorretos. Confira os dados e tente novamente.',
  'Your e-mail is not confirmed yet. Open the confirmation link we sent you, then sign in.':
    'Seu e-mail ainda não foi confirmado. Abra o link de confirmação que enviamos e depois entre.',
  'This e-mail is already registered. Sign in or reset your password.':
    'Este e-mail já está cadastrado. Entre ou redefina sua senha.',
  'Too many e-mails were sent to this address. Wait a few minutes and try again.':
    'Muitos e-mails foram enviados para este endereço. Aguarde alguns minutos e tente novamente.',
  'Too many attempts. Wait a moment and try again.':
    'Muitas tentativas. Aguarde um instante e tente novamente.',
  'New sign-ups are disabled right now. Contact support.':
    'Novos cadastros estão desativados no momento. Entre em contato com o suporte.',
  'The new password must be different from the current one.':
    'A nova senha precisa ser diferente da atual.',
  'This link is invalid or has expired. Request a new one.':
    'Este link é inválido ou expirou. Solicite um novo.',

  // ---- /join/[token] — invitation page ----
  '. Link valid until': '. Link válido até',
  'Accepting…': 'Aceitando…',
  ', sign out and sign up again with a different e-mail. The invite link stays valid until it expires.':
    ', saia e cadastre-se novamente com outro e-mail. O link do convite continua válido até expirar.',
  'Unable to join': 'Não é possível entrar em',
  'with this account': 'com esta conta',
  'Password must be at least 8 characters': 'A senha deve ter no mínimo 8 caracteres',
};
