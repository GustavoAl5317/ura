// Atalhos de rota: quando a pergunta tem um sinal inequívoco do assunto, o
// modelo recebe a ferramenta certa por escrito, antes de escolher.
//
// Existe porque o vocabulário sozinho não bastou. Na operação de 02/10:
//   - "como está a rede da RNP?" foi parar em ctos_por_bairro, cinco vezes,
//     mesmo com o termo RNP explicado no prompt. "Rede" puxa para bairro.
//   - "quantos cancelamentos no Bolsa Fesso hoje?" virou busca de CLIENTE
//     chamado Bolsa Fesso, seis vezes seguidas, até estourar o limite.
// Aqui não há interpretação: só padrões que não deixam dúvida.

export interface Rota {
  assunto: string;
  instrucao: string;
  /** Ferramenta que a primeira rodada do modelo é OBRIGADA a chamar. */
  ferramenta: string;
}

/** Links de terceiros como se fala, e o nome que vai para zabbix_link. */
const LINKS: Array<{ casa: RegExp; nome: string }> = [
  { casa: /\brnp\b|giga ?for/i, nome: 'RNP' },
  { casa: /etice|\betis\b|\bethis\b|\banetice\b|cintur[aã]o digital/i, nome: 'Etice' },
  { casa: /angola/i, nome: 'Angola' },
  { casa: /\bat ?& ?t\b|\bat-t\b/i, nome: 'AT&T' },
  { casa: /\bix-?ce\b|\bptt\b/i, nome: 'IX-CE' },
];

export function rotasDaPergunta(pergunta: string): Rota[] {
  const p = pergunta.normalize('NFD').replace(/[̀-ͯ]/g, '');
  const rotas: Rota[] = [];

  const link = LINKS.find((l) => l.casa.test(p));
  // "caixa de emenda perto da Angola" é planta, não link.
  if (link && !/caixa[s]? de emenda|\bceo\b|\bclo\b/i.test(p)) {
    rotas.push({
      assunto: `link ${link.nome}`,
      ferramenta: 'zabbix_link',
      instrucao:
        `A pergunta é sobre o LINK ${link.nome} (rede de operadora ou circuito), não sobre bairro nem caixa. ` +
        `Chame zabbix_link com link="${link.nome}". Ela diz em que equipamento e porta ele está e se está no ar. ` +
        'NÃO use ctos_por_bairro, saude_da_rede nem clientes_da_cto para isso.',
    });
  }

  if (/cancel|desist|pedi(u|ram) (pra|para) sair/i.test(p)) {
    rotas.push({
      assunto: 'cancelamentos',
      ferramenta: 'relatorio_cancelamentos',
      instrucao:
        'A pergunta é sobre CANCELAMENTOS (contagem). Chame relatorio_cancelamentos; com bairro se citar lugar ' +
        '(passe o nome como foi dito) e so_hoje=true se disser "hoje". NÃO procure cliente com esse nome: ' +
        'nome de lugar não é nome de cliente.',
    });
  }

  return rotas;
}

const ETAPA = /\b((?:primeir|segund|terceir|quart|quint|sext|setim|oitav)[ao]|\d+\s*[ºªa°]?)\s+etapa\b|\betapa\s+(\d+|[ivx]+)\b/i;

/**
 * O modelo encurta o bairro: "segunda etapa do Conjunto Ceará" chegou à
 * ferramenta como "Conjunto Ceará", e a resposta saiu sobre as quatro etapas
 * juntas. Se a pergunta diz a etapa e o bairro passado não tem número nenhum,
 * a etapa volta para o bairro.
 */
export function completarBairro(bairro: string, pergunta: string): string {
  const m = ETAPA.exec(pergunta.normalize('NFD').replace(/[̀-ͯ]/g, ''));
  if (!m) return bairro;
  if (/\d|\b[ivx]+\b|etapa/i.test(bairro.normalize('NFD').replace(/[̀-ͯ]/g, ''))) return bairro;
  return `${bairro} ${m[0]}`;
}
