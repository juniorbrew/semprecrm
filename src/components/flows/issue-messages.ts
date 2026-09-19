/**
 * pt-BR rendering for the flow validator's messages.
 *
 * `validateFlowForActivation` (src/lib/flows/validate.ts) builds its
 * messages in English, many of them with interpolated node keys, ids and
 * limits. Static messages resolve through the dictionary like any other
 * copy; the interpolated ones can't match a dictionary key, so this
 * module rewrites them by pattern. Anything it doesn't recognise falls
 * back to the English text — never a blank line.
 *
 * Lives next to the validation panel (not in the dictionary) because the
 * shapes are specific to the flow validator and the app's dynamic
 * translator (`translateDynamic` in src/lib/i18n.ts) is kept generic.
 */

import type { Language } from "@/lib/i18n";

type Rule = [RegExp, (m: RegExpMatchArray) => string];

const PT_RULES: Rule[] = [
  [/^Entry node "(.+)" doesn't exist\.$/, (m) => `O nó de entrada “${m[1]}” não existe.`],
  [/^Duplicate node_key "(.+)"\.$/, (m) => `Chave de nó duplicada “${m[1]}”.`],
  [/^Node "(.+)" is unreachable from the entry node\.$/, (m) => `O nó “${m[1]}” não pode ser alcançado a partir do nó de entrada.`],
  [/^(\d+) keywords? (?:is|are) blank — they won't match anything\.$/, (m) =>
    m[1] === "1"
      ? "1 palavra-chave está em branco — ela não vai corresponder a nada."
      : `${m[1]} palavras-chave estão em branco — elas não vão corresponder a nada.`],
  [/^Start points to non-existent node "(.+)"\.$/, (m) => `O nó Início aponta para um nó inexistente: “${m[1]}”.`],
  [/^Send-message points to non-existent node "(.+)"\.$/, (m) => `O nó Enviar mensagem aponta para um nó inexistente: “${m[1]}”.`],
  [/^Send-media points to non-existent node "(.+)"\.$/, (m) => `O nó Enviar mídia aponta para um nó inexistente: “${m[1]}”.`],
  [/^Collect-input points to non-existent node "(.+)"\.$/, (m) => `O nó Coletar resposta aponta para um nó inexistente: “${m[1]}”.`],
  [/^Set-tag points to non-existent node "(.+)"\.$/, (m) => `O nó Etiquetar contato aponta para um nó inexistente: “${m[1]}”.`],
  [/^Caption exceeds (\d+) chars \(WhatsApp limit\)\.$/, (m) => `A legenda ultrapassa ${m[1]} caracteres (limite do WhatsApp).`],
  [/^WhatsApp allows at most (\d+) buttons per message\.$/, (m) => `O WhatsApp permite no máximo ${m[1]} botões por mensagem.`],
  [/^Button (\d+) needs a reply id\.$/, (m) => `O botão ${m[1]} precisa de um ID de resposta.`],
  [/^Duplicate button reply id "(.+)"\.$/, (m) => `ID de resposta de botão duplicado: “${m[1]}”.`],
  [/^Button (\d+) needs a title\.$/, (m) => `O botão ${m[1]} precisa de um título.`],
  [/^Button (\d+) title is over (\d+) chars \(WhatsApp limit\)\.$/, (m) => `O título do botão ${m[1]} ultrapassa ${m[2]} caracteres (limite do WhatsApp).`],
  [/^Button (\d+) needs a next node\.$/, (m) => `O botão ${m[1]} precisa de um próximo nó.`],
  [/^Button (\d+) points to non-existent node "(.+)"\.$/, (m) => `O botão ${m[1]} aponta para um nó inexistente: “${m[2]}”.`],
  [/^Send-list allows at most (\d+) rows total across sections\.$/, (m) => `A lista permite no máximo ${m[1]} linhas no total entre todas as seções.`],
  [/^Row (\d+) in section (\d+) needs a reply id\.$/, (m) => `A linha ${m[1]} da seção ${m[2]} precisa de um ID de resposta.`],
  [/^Duplicate list row id "(.+)"\.$/, (m) => `ID de linha da lista duplicado: “${m[1]}”.`],
  [/^Row (\d+) needs a title\.$/, (m) => `A linha ${m[1]} precisa de um título.`],
  [/^Row (\d+) title exceeds (\d+) chars\.$/, (m) => `O título da linha ${m[1]} ultrapassa ${m[2]} caracteres.`],
  [/^Row (\d+) description exceeds (\d+) chars\.$/, (m) => `A descrição da linha ${m[1]} ultrapassa ${m[2]} caracteres.`],
  [/^Row (\d+) needs a next node\.$/, (m) => `A linha ${m[1]} precisa de um próximo nó.`],
  [/^Row (\d+) points to non-existent node "(.+)"\.$/, (m) => `A linha ${m[1]} aponta para um nó inexistente: “${m[2]}”.`],
  [/^var_key "(.+)" must be alphanumeric\+underscore and start with a letter or underscore\.$/, (m) =>
    `A chave da variável “${m[1]}” deve conter apenas letras, números e sublinhado, e começar com letra ou sublinhado.`],
  [/^Operator "(.+)" usually expects a comparison value — empty value will only match empty subjects\.$/, (m) =>
    `O operador “${m[1]}” normalmente espera um valor de comparação — um valor vazio só corresponde a assuntos vazios.`],
  [/^Condition needs a node for the "(true|false)" branch\.$/, (m) =>
    `A condição precisa de um nó para o ramo “${m[1] === "true" ? "verdadeiro" : "falso"}”.`],
  [/^Condition's "(true_next|false_next)" points to non-existent node "(.+)"\.$/, (m) =>
    `O ramo “${m[1] === "true_next" ? "verdadeiro" : "falso"}” da condição aponta para um nó inexistente: “${m[2]}”.`],
  [/^Unknown node type "(.+)"\.$/, (m) => `Tipo de nó desconhecido: “${m[1]}”.`],
];

/**
 * Returns the message in the active language. Static messages go through
 * `t` (dictionary); interpolated ones through the pattern table above.
 */
export function translateIssueMessage(
  message: string,
  language: Language,
  t: (english: string) => string,
): string {
  if (language !== "pt-BR") return message;
  const viaDictionary = t(message);
  if (viaDictionary !== message) return viaDictionary;
  for (const [re, render] of PT_RULES) {
    const m = message.match(re);
    if (m) return render(m);
  }
  return message;
}
