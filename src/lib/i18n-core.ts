// Language constants and the literal translation engine. Dictionary-free on
// purpose: client code imports this (via i18n-runtime) while the full
// catalogue in i18n.ts stays server/test only.
type Dict = Record<string, string>;

export const LANGUAGES = ['pt-BR', 'en-US'] as const;
export type Language = (typeof LANGUAGES)[number];

export const DEFAULT_LANGUAGE: Language = 'pt-BR';
export const LANGUAGE_STORAGE_KEY = 'semprecrm-language';

export function isLanguage(value: unknown): value is Language {
  return LANGUAGES.includes(value as Language);
}

export function translateWith(
  enToPt: Dict,
  ptToEn: Dict,
  value: string,
  language: Language
): string {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const normalized = trimmed.replace(/\s+/g, ' ');
  const translated =
    language === 'pt-BR' ? enToPt[normalized] : ptToEn[normalized];
  if (!translated) return translateDynamic(enToPt, value, language);
  const start = value.indexOf(trimmed);
  return (
    value.slice(0, start) + translated + value.slice(start + trimmed.length)
  );
}

function translateDynamic(
  enToPt: Dict,
  value: string,
  language: Language
): string {
  const trimmed = value.trim().replace(/\s+/g, ' ');
  const wrap = (text: string) => value.replace(value.trim(), text);

  if (language === 'pt-BR') {
    let match: RegExpMatchArray | null;
    if ((match = trimmed.match(/^(\d+) runs?$/)))
      return wrap(`${match[1]} ${match[1] === '1' ? 'execução' : 'execuções'}`);
    if ((match = trimmed.match(/^last (.+)$/)))
      return wrap(`última: ${match[1]}`);
    if ((match = trimmed.match(/^(\d+) total contacts\.?$/)))
      return wrap(
        `${match[1]} contato${match[1] === '1' ? '' : 's'} no total.`
      );
    if ((match = trimmed.match(/^(\d+) contacts? deleted$/)))
      return wrap(
        `${match[1]} contato${match[1] === '1' ? '' : 's'} excluído${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(\d+) contacts? imported$/)))
      return wrap(
        `${match[1]} contato${match[1] === '1' ? '' : 's'} importado${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(\d+) tag assignments? applied$/)))
      return wrap(
        `${match[1]} atribuição${match[1] === '1' ? '' : 'ões'} de etiqueta aplicada${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(\d+) contacts? failed to import$/)))
      return wrap(
        `${match[1]} contato${match[1] === '1' ? '' : 's'} não importado${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(\d+) open deals?$/)))
      return wrap(
        `${match[1]} negócio${match[1] === '1' ? '' : 's'} aberto${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(\d+) unread conversations?$/)))
      return wrap(
        `${match[1]} conversa${match[1] === '1' ? '' : 's'} não lida${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^Showing (\d+)-(\d+) of (\d+)$/)))
      return wrap(`Mostrando ${match[1]}-${match[2]} de ${match[3]}`);
    if ((match = trimmed.match(/^Page (\d+) of (\d+)$/)))
      return wrap(`Página ${match[1]} de ${match[2]}`);
    if ((match = trimmed.match(/^Select contact (.+)$/)))
      return wrap(`Selecionar contato ${match[1]}`);
    if ((match = trimmed.match(/^(\d+) s ago$/)))
      return wrap(`há ${match[1]} s`);
    if ((match = trimmed.match(/^(\d+)([hm]) remaining$/)))
      return wrap(`${match[1]}${match[2]} restantes`);
    if ((match = trimmed.match(/^File is (.+) MB — limit is 16 MB\.$/)))
      return wrap(`O arquivo possui ${match[1]} MB — o limite é 16 MB.`);
    if ((match = trimmed.match(/^Failed to load \((.+)\)$/)))
      return wrap(`Falha ao carregar (${match[1]})`);
    if ((match = trimmed.match(/^Failed: (.+)$/)))
      return wrap(`Falhou: ${match[1]}`);
    if ((match = trimmed.match(/^Failed to delete: (.+)$/)))
      return wrap(`Falha ao excluir: ${match[1]}`);
    if ((match = trimmed.match(/^Status update failed: (.+)$/)))
      return wrap(`Falha ao atualizar o status: ${match[1]}`);
    if ((match = trimmed.match(/^Password must be at least (\d+) characters$/)))
      return wrap(`A senha deve ter pelo menos ${match[1]} caracteres`);
    if ((match = trimmed.match(/^Label must be (\d+) characters or fewer$/)))
      return wrap(`O rótulo deve ter no máximo ${match[1]} caracteres`);
    if ((match = trimmed.match(/^expires in (\d+) days?$/)))
      return wrap(`expira em ${match[1]} dia${match[1] === '1' ? '' : 's'}`);
    if ((match = trimmed.match(/^expires in (\d+) hours?$/)))
      return wrap(`expira em ${match[1]} hora${match[1] === '1' ? '' : 's'}`);
    if ((match = trimmed.match(/^(\d+) members?(.*)$/)))
      return wrap(
        `${match[1]} membro${match[1] === '1' ? '' : 's'}${match[2]}`
      );
    if ((match = trimmed.match(/^(\d+) templates?(.*)$/)))
      return wrap(
        `${match[1]} modelo${match[1] === '1' ? '' : 's'}${match[2]}`
      );
    if ((match = trimmed.match(/^(\d+) pending invites?$/)))
      return wrap(
        `${match[1]} convite${match[1] === '1' ? '' : 's'} pendente${match[1] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(\d+) pending review$/)))
      return wrap(`${match[1]} em análise`);
    if ((match = trimmed.match(/^(\d+) tags? · (\d+) custom fields?$/)))
      return wrap(
        `${match[1]} etiqueta${match[1] === '1' ? '' : 's'} · ${match[2]} campo${match[2] === '1' ? '' : 's'} personalizado${match[2] === '1' ? '' : 's'}`
      );
    if ((match = trimmed.match(/^(.+) mode · (.+) accent$/)))
      return wrap(`modo ${match[1]} · destaque ${match[2]}`);
    if ((match = trimmed.match(/^Updated (.+) to (.+)$/)))
      return wrap(`${match[1]} atualizado para ${match[2]}`);
    if ((match = trimmed.match(/^File is (.+) MB — Meta's limit is 5 MB\.$/)))
      return wrap(`A imagem possui ${match[1]} MB — o limite da Meta é 5 MB.`);
    // "<prefix>: <api error>" — the tail is usually an API message that
    // has its own dictionary entry, so it goes through the lookup too.
    const tail = (text: string) => enToPt[text.trim()] ?? text;
    if ((match = trimmed.match(/^Upload failed: (.+)$/)))
      return wrap(`Falha no envio: ${tail(match[1])}`);
    if ((match = trimmed.match(/^Failed to send: (.+)$/)))
      return wrap(`Falha ao enviar: ${tail(match[1])}`);
    if ((match = trimmed.match(/^Email change failed: (.+)$/)))
      return wrap(`Falha ao alterar o e-mail: ${tail(match[1])}`);
    if ((match = trimmed.match(/^Sign-out failed: (.+)$/)))
      return wrap(`Falha ao sair: ${tail(match[1])}`);
    if ((match = trimmed.match(/^Password change failed: (.+)$/)))
      return wrap(`Falha ao alterar a senha: ${tail(match[1])}`);
    if ((match = trimmed.match(/^Meta API error: (.+)$/)))
      return wrap(`Erro da API da Meta: ${match[1]}`);
    if ((match = trimmed.match(/^Meta API rejected the credentials: (.+)$/)))
      return wrap(`A Meta rejeitou as credenciais: ${match[1]}`);
    if ((match = trimmed.match(/^(.+) must be (\d+) characters or fewer$/))) {
      const subject = enToPt[match[1]] ?? match[1];
      const lower = subject.charAt(0).toLowerCase() + subject.slice(1);
      return wrap(`O ${lower} deve ter no máximo ${match[2]} caracteres`);
    }
    if (
      (match = trimmed.match(
        /^Delete "(.+)"\? Any active runs will end immediately\.$/
      ))
    )
      return wrap(
        `Excluir “${match[1]}”? Todas as execuções ativas serão encerradas imediatamente.`
      );
  }

  return value;
}
