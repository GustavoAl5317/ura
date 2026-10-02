// Vocabulário da casa: como as pessoas falam, e o que isso significa aqui.
//
// O assistente foi escrito por quem sabe o que é CTO, PON e ONU. Quem pergunta,
// muitas vezes, não sabe — e não deveria precisar saber. "A caixinha da esquina
// tá apagada", "o pessoal do 731 tá sem net" e "o aparelho tá piscando
// vermelho" são perguntas perfeitamente claras para um colega, e viravam
// "INCONCLUSIVO" para o modelo.
//
// A tradução mora em banco, não no prompt, por dois motivos:
//   1. cada região tem o seu jeito de falar, e isso muda sem deploy;
//   2. só os termos que aparecem na pergunta entram no prompt, então o
//      vocabulário pode crescer sem encarecer toda consulta.

import { randomUUID } from 'crypto';
import { db, registrarAuditoria } from './store/db';
import { obter } from './config-dinamica';

export interface Termo {
  id: string;
  termo: string;
  /** Outras formas de dizer a mesma coisa, separadas por vírgula. */
  sinonimos: string[];
  significado: string;
  /** O que fazer com isso: qual ferramenta ou dado resolve. */
  dica: string | null;
  ativo: boolean;
  usos: number;
  criado_em: string;
}

interface Linha extends Omit<Termo, 'sinonimos' | 'ativo'> { sinonimos: string | null; ativo: number }

function paraTermo(l: Linha): Termo {
  return {
    ...l,
    sinonimos: (l.sinonimos ?? '').split(',').map((x) => x.trim()).filter(Boolean),
    ativo: l.ativo === 1,
  };
}

export function listar(): Termo[] {
  return (db().prepare(`SELECT * FROM glossario ORDER BY termo`).all() as Linha[]).map(paraTermo);
}

export function porId(id: string): Termo | null {
  const l = db().prepare(`SELECT * FROM glossario WHERE id = ?`).get(id) as Linha | undefined;
  return l ? paraTermo(l) : null;
}

function normalizar(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function criar(d: { termo?: string; sinonimos?: unknown; significado?: string; dica?: string; ativo?: boolean }, autor: string): Termo {
  const termo = String(d.termo ?? '').trim();
  if (termo.length < 2) throw new Error('escreva o termo (pelo menos 2 letras)');
  const significado = String(d.significado ?? '').trim();
  if (!significado) throw new Error('escreva o que esse termo significa aqui');
  const sin = Array.isArray(d.sinonimos)
    ? d.sinonimos.map(String).map((x) => x.trim()).filter(Boolean)
    : String(d.sinonimos ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  if (listar().some((t) => normalizar(t.termo) === normalizar(termo))) {
    throw new Error(`"${termo}" já está no vocabulário`);
  }

  const t: Termo = {
    id: randomUUID(), termo, sinonimos: sin, significado,
    dica: String(d.dica ?? '').trim() || null, ativo: d.ativo !== false,
    usos: 0, criado_em: new Date().toISOString(),
  };
  db().prepare(
    `INSERT INTO glossario (id, termo, sinonimos, significado, dica, ativo, usos, criado_em)
     VALUES (?,?,?,?,?,?,0,?)`,
  ).run(t.id, t.termo, t.sinonimos.join(', '), t.significado, t.dica, t.ativo ? 1 : 0, t.criado_em);
  registrarAuditoria(autor, 'glossario.criar', t.termo, undefined, t);
  return t;
}

export function atualizar(id: string, d: Record<string, unknown>, autor: string): Termo {
  const antes = porId(id);
  if (!antes) throw new Error('termo não encontrado');
  const sin = d.sinonimos === undefined ? antes.sinonimos
    : Array.isArray(d.sinonimos) ? d.sinonimos.map(String).map((x) => x.trim()).filter(Boolean)
      : String(d.sinonimos ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const significado = d.significado !== undefined && String(d.significado).trim()
    ? String(d.significado).trim() : antes.significado;
  db().prepare(
    `UPDATE glossario SET termo = ?, sinonimos = ?, significado = ?, dica = ?, ativo = ? WHERE id = ?`,
  ).run(
    d.termo !== undefined && String(d.termo).trim() ? String(d.termo).trim() : antes.termo,
    sin.join(', '), significado,
    d.dica !== undefined ? (String(d.dica ?? '').trim() || null) : antes.dica,
    d.ativo !== undefined ? (d.ativo !== false ? 1 : 0) : (antes.ativo ? 1 : 0),
    id,
  );
  const depois = porId(id)!;
  registrarAuditoria(autor, 'glossario.editar', depois.termo, antes, depois);
  return depois;
}

export function remover(id: string, autor: string): void {
  const antes = porId(id);
  if (!antes) throw new Error('termo não encontrado');
  db().prepare(`DELETE FROM glossario WHERE id = ?`).run(id);
  registrarAuditoria(autor, 'glossario.remover', antes.termo, antes, undefined);
}

/**
 * Trechos [início, fim) da pergunta normalizada onde a expressão aparece:
 * palavra inteira, sem acento, sem diferenciar maiúscula, com plural.
 */
function trechos(texto: string, expressao: string): Array<[number, number]> {
  const alvo = normalizar(expressao).trim();
  if (!alvo) return [];
  const escapado = alvo.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(^|[^a-z0-9])(${escapado}(?:s|es)?)(?=[^a-z0-9]|$)`, 'gi');
  const t = normalizar(texto);
  const saida: Array<[number, number]> = [];
  for (let m = re.exec(t); m; m = re.exec(t)) {
    const ini = m.index + m[1].length;
    saida.push([ini, ini + m[2].length]);
  }
  return saida;
}

/**
 * Termos do vocabulário que aparecem nesta pergunta. Um termo que só aparece
 * DENTRO de outro mais longo fica de fora: em "caixa de emenda", o "caixa" do
 * termo caixinha (CTO) não conta, e o modelo não recebe as duas leituras.
 */
export function termosEncontrados(pergunta: string): Termo[] {
  if (!pergunta.trim()) return [];
  const achados = listar()
    .filter((t) => t.ativo)
    .map((t) => ({ t, spans: [t.termo, ...t.sinonimos].flatMap((x) => trechos(pergunta, x)) }))
    .filter((x) => x.spans.length > 0);
  const dentroDeOutro = (sp: [number, number], dono: Termo) => achados.some((o) => o.t.id !== dono.id &&
    o.spans.some((q) => q[0] <= sp[0] && q[1] >= sp[1] && q[1] - q[0] > sp[1] - sp[0]));
  return achados.filter((x) => x.spans.some((sp) => !dentroDeOutro(sp, x.t))).map((x) => x.t);
}

export function marcarUso(ids: string[]): void {
  if (!ids.length) return;
  const agora = new Date().toISOString();
  const st = db().prepare(`UPDATE glossario SET usos = usos + 1, ultimo_uso = ? WHERE id = ?`);
  for (const id of ids) st.run(agora, id);
}

/**
 * Bloco para o prompt, só com os termos que a pergunta usou. Devolve null
 * quando não há nada a traduzir — nenhuma consulta paga por vocabulário que
 * não foi usado.
 */
export function blocoParaPrompt(pergunta: string): { texto: string; ids: string[] } | null {
  if (!obter<boolean>('ia.glossario_ativo')) return null;
  const achados = termosEncontrados(pergunta);
  if (!achados.length) return null;
  const linhas = achados.map((t) => `- "${t.termo}"${t.sinonimos.length ? ` (também: ${t.sinonimos.join(', ')})` : ''}: ${t.significado}${t.dica ? ` → ${t.dica}` : ''}`);
  return {
    ids: achados.map((t) => t.id),
    texto:
      'Como se fala aqui, e o que isso quer dizer. A pessoa usou estes termos; trate-os com este ' +
      'significado e NÃO peça para ela reformular:\n' + linhas.join('\n'),
  };
}

/**
 * Vocabulário inicial. É o jeito como técnico de campo, atendente e cliente
 * falam de verdade — não a nomenclatura do manual. A casa edita no painel.
 */
interface SementeTermo { termo: string; sinonimos: string; significado: string; dica: string }

export const SEMENTE: SementeTermo[] = [
  {
    termo: 'caixinha', sinonimos: 'caixa, caixa da rua, caixa do poste, caixinha da esquina, cx',
    significado: 'A CTO: a caixa de fibra no poste onde os clientes daquela rua são ligados.',
    dica: 'Use as ferramentas de CTO (sinal, clientes ligados, analisar_cto).',
  },
  {
    termo: 'aparelho', sinonimos: 'aparelhinho, modem, roteador, conversor, caixinha de dentro',
    significado: 'O equipamento na casa do cliente (ONU/ONT). "Luz vermelha" ou "apagado" indica fibra ou sinal.',
    dica: 'Veja sinal e status da ONU pela revisão do cliente.',
  },
  {
    termo: 'sem net', sinonimos: 'sem internet, sem conexão, caiu a net, net caiu, sem sinal, tá offline, nao tem net',
    significado: 'Cliente ou região sem conexão. Pode ser queda da CTO, da PON, do POP ou só daquele cliente.',
    dica: 'Comece pelo alvo citado: se for cliente, revisão; se for rua, bairro ou caixa, analise a CTO ou a PON.',
  },
  {
    termo: 'tá lento', sinonimos: 'ta lento, lentidao, lentidão, travando, ruim, oscilando, caindo toda hora',
    significado: 'Queixa de qualidade, não de queda: pode ser sinal óptico ruim, PON cheia ou tráfego.',
    dica: 'Olhe sinal da ONU e da CTO, e tráfego do momento. Oscilação repetida é flap: veja o histórico.',
  },
  {
    termo: 'fibra arrebentou', sinonimos: 'arrebentou, rompeu, cortaram a fibra, fibra cortada, passaram por cima do cabo',
    significado: 'Suspeita de rompimento. Só é rompimento quando quase todas as ONUs do trecho estão sem luz.',
    dica: 'Analise a PON ou a CTO e use a leitura do padrão da própria ferramenta, sem concluir por conta.',
  },
  {
    termo: 'poste', sinonimos: 'poste caiu, bateu no poste, carro bateu no poste',
    significado: 'Acidente que costuma derrubar a caixa inteira daquele trecho.',
    dica: 'Verifique a CTO e as vizinhas do mesmo trecho.',
  },
  {
    termo: 'faltou luz', sinonimos: 'sem energia, acabou a luz, apagão, apagao, queda de energia, energia caiu',
    significado: 'Falta de energia na casa, na caixa ou no POP. Sem energia no POP, cai todo mundo da região.',
    dica: 'Veja alertas de energia no Zabbix e quantos clientes do trecho caíram juntos.',
  },
  {
    termo: 'o pessoal', sinonimos: 'a galera, o povo, os moradores, a rua toda, o bairro',
    significado: 'Um grupo de clientes de uma rua, bairro ou condomínio — não um cliente só.',
    dica: 'Trate como região: procure a CTO ou a PON que atende o lugar citado.',
  },
  {
    termo: 'conta', sinonimos: 'boleto, fatura, pagamento, bloqueado, cortado, suspenso',
    significado: 'Situação financeira ou bloqueio do contrato, não falha técnica.',
    dica: 'Veja a situação do contrato no SGP antes de investigar rede.',
  },
  {
    termo: 'chamado', sinonimos: 'os, o.s., ordem de serviço, visita, técnico foi lá, abriu chamado',
    significado: 'Ordem de serviço no SGP, aberta para instalação, reparo ou retirada.',
    dica: 'Procure as O.S. do cliente ou da região antes de sugerir abrir outra.',
  },
  {
    termo: 'caixa de emenda', sinonimos: 'caixas de emenda, ceo, clo, caixa de fusao, caixa de fusão, emenda optica, emenda óptica, fusionamento, fusoes, fusões',
    significado: 'Caixa onde um cabo de fibra é emendado (fundido) em outro, ao longo do trajeto. NÃO é CTO: não tem cliente nem porta, mesmo tendo "caixa" no nome. "AS 12 FO" é cabo de 12 fibras: 12 fusões de cada lado.',
    dica: 'Use caixas_de_emenda (planta do GeoSite), por bairro ou por endereço/ponto de referência. Atenuação e estado das fusões não são medidos por sistema nenhum: diga isso, não invente.',
  },
  {
    termo: 'RNP', sinonimos: 'rede da rnp, gigafor, giga for, rede nacional de ensino',
    significado: 'Rede de terceiro (RNP, anel metropolitano GigaFOR) com que a casa troca tráfego ou por onde passa circuito. Não é rede de caixas de bairro.',
    dica: 'Use zabbix_link com "rnp"; se não achar, tente "gigafor". Se nada no Zabbix tiver esse nome, diga isso e pergunte o nome da interface ou do circuito. Não troque por análise de bairro.',
  },
  {
    termo: 'Etice', sinonimos: 'rede da etice, anetice, a etice, cinturao digital, cinturão digital',
    significado: 'Rede de terceiro (ETICE, Cinturão Digital do Ceará) com que a casa tem link ou circuito. Não é rede de caixas de bairro. Transcrição de áudio costuma escrever "Anetice" ou "a Etice".',
    dica: 'Use zabbix_link com "etice"; se não achar, tente "cinturao". Se nada no Zabbix tiver esse nome, diga isso e pergunte o nome da interface ou do circuito.',
  },
  {
    termo: 'Angola Cables', sinonimos: 'angola cable, angola, hotel cable, cable hotel, hotel cables, cables',
    significado: 'Data center da Angola Cables na Praia do Futuro (Fortaleza), ponto de chegada de cabos submarinos onde a casa interliga circuito.',
    dica: 'Link: zabbix_link com "angola". Caixa de emenda perto dali: caixas_de_emenda com endereco "Angola Cables, Praia do Futuro, Fortaleza".',
  },
  {
    termo: 'rede do bairro', sinonimos: 'rede do, rede da, projeto, projetos, a rede ali, rede la',
    significado: 'Para quem não é técnico, "a rede do Bom Sucesso" são as caixas (CTOs) e os clientes daquele bairro, e "projeto" é um trecho de rede construído. Não é link de operadora, a não ser que cite RNP, Etice ou Angola.',
    dica: 'Para "como está", use saude_da_rede com o bairro; para "quantas caixas/clientes", ctos_por_bairro. Passe o nome do bairro como a pessoa falou: a ferramenta resolve nome mal ouvido.',
  },
  {
    termo: 'luz da caixa', sinonimos: 'luz alta, luz baixa, luz forte, luz fraca, luz ruim, a luz, sinal alto, sinal baixo, potencia',
    significado: 'Sinal da fibra (potência óptica em dBm). Leigo diz "luz alta" tanto para sinal ruim quanto para sinal forte demais. "Faltou luz" é outra coisa: energia.',
    dica: 'Use ctos_sinal_ruim ou cto_sinal. Se não der para saber o sentido, responda as caixas com sinal ruim (mais negativo que o corte) e diga o critério em palavras.',
  },
  {
    termo: 'casos', sinonimos: 'caso, ocorrencia, ocorrência, ocorrencias, ocorrências, reclamacao, reclamação, reclamacoes, reclamações, problemas no bairro',
    significado: 'Chamados abertos (O.S.) dos clientes de um lugar.',
    dica: 'Use os_abertas_na_rede com o bairro.',
  },
  {
    termo: 'cancelamento', sinonimos: 'cancelamentos, cancelou, cancelaram, pediu pra sair, pediram pra sair, desistiu, desistencia, desistência',
    significado: 'Cliente que cancelou o contrato.',
    dica: 'Use relatorio_cancelamentos; com bairro quando citar lugar, e so_hoje quando disser "hoje".',
  },
  {
    termo: 'endereço da caixa', sinonimos: 'onde fica a caixa, onde fica essa caixa, em qual rua, qual rua, qual o endereco, qual o endereço, localizacao da caixa, localização da caixa',
    significado: 'Em que rua está a CTO.',
    dica: 'As ferramentas de CTO trazem endereco_provavel (rua dos clientes dela) e mapa. Use os dois; diga que a rua vem dos clientes e o link é a posição exata.',
  },
];

/**
 * Semeia o vocabulário. Na primeira vez, tudo. Depois, só os termos novos da
 * semente que ainda não existem e que ninguém removeu no painel: um termo
 * apagado pela casa foi decisão dela, e não volta sozinho a cada deploy.
 */
export function semear(): number {
  const st = db().prepare(
    `INSERT INTO glossario (id, termo, sinonimos, significado, dica, ativo, usos, criado_em)
     VALUES (?,?,?,?,?,1,0,?)`,
  );
  const existentes = new Set(listar().map((t) => normalizar(t.termo)));
  const removidos = new Set((db().prepare(
    `SELECT alvo FROM auditoria WHERE acao = 'glossario.remover' AND alvo IS NOT NULL`,
  ).all() as Array<{ alvo: string }>).map((l) => normalizar(l.alvo)));
  const agora = new Date().toISOString();
  let n = 0;
  for (const t of SEMENTE) {
    const k = normalizar(t.termo);
    if (existentes.has(k) || removidos.has(k)) continue;
    st.run(randomUUID(), t.termo, t.sinonimos, t.significado, t.dica, agora);
    n++;
  }
  return n;
}
