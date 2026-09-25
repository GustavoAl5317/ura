// Detecta, pela transcrição, quando o cliente pede para a URA esperar e quando
// volta. O vigia de silêncio usa isso para não perguntar "você está na linha?"
// — nem desligar — enquanto o cliente atende alguém ou vai buscar um documento.
//
// As expressões são estreitas de propósito. "um minuto" solto aparece em
// "caiu faz um minuto", e tratar isso como pedido de pausa faria a URA
// responder "fico aguardando" a uma reclamação. Por isso só vale com o verbo
// ("espera um minuto"), com "só" ("só um minuto") ou no começo da frase.
//
// Não usa \b: no JavaScript ele só conhece letra sem acento, e "peraí", "aí",
// "só", "alô" terminam em acento — o \b depois deles nunca casaria. INI e FIM
// fazem o papel de fronteira de palavra entendendo acento.

export type StatusFala = 'CLIENTE_PAUSOU' | 'EM_PAUSA' | 'RETORNOU' | '';

const LETRA = 'a-zA-Z0-9À-ÿ';
const INI = `(?<![${LETRA}])`;
const FIM = `(?![${LETRA}])`;
const re = (corpo: string) => new RegExp(corpo, 'i');

const PEDIDO_DE_PAUSA: RegExp[] = [
  re(`^\\s*(espera|espere|aguarda|aguarde|peraí|perai|pera aí|pera ai|segura aí|segura ai)${FIM}`),
  re(`${INI}(espera|espere|aguarda|aguarde)\\s+(aí|ai|um|uma|só|so|lá|la)${FIM}`),
  re(`${INI}(só|so|espera|aguarda|me dá|me da|dá|da)\\s+(um|uma)\\s+(minuto|minutinho|momento|momentinho|instante|segundo|segundinho)${FIM}`),
  re(`^\\s*(um\\s+)?(minuto|minutinho|momento|momentinho|instante|segundinho)${FIM}`),
  re(`${INI}(só|so)\\s+um\\s+(pouco|pouquinho)${FIM}`),
  re(`${INI}(já volto|ja volto|calma aí|calma ai)${FIM}`),
];

const SINAL_DE_RETORNO = re(
  `${INI}(voltei|pronto|pode continuar|pode falar|pode seguir|estou aqui|tô aqui|to aqui|oi|alô|alo)${FIM}`,
);

export function pediuPausa(texto: string): boolean {
  return PEDIDO_DE_PAUSA.some((r) => r.test(texto));
}

/**
 * Status desta fala, dado se a ligação já estava em pausa.
 * - pediu para esperar           → CLIENTE_PAUSOU
 * - em pausa e sinalizou retorno → RETORNOU
 * - em pausa e falou outra coisa → EM_PAUSA (pode ser conversa com outra pessoa)
 */
export function statusDaFala(texto: string, emPausa: boolean): StatusFala {
  if (pediuPausa(texto)) return 'CLIENTE_PAUSOU';
  if (!emPausa) return '';
  return SINAL_DE_RETORNO.test(texto) ? 'RETORNOU' : 'EM_PAUSA';
}
