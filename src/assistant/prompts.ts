// Prompts do assistente, versionados em banco.
//
// O texto abaixo é só a SEMENTE: na primeira execução vira a versão 1 no banco,
// e daí em diante quem manda é o que estiver ativo lá. Isso é o que permite
// ajustar o comportamento pelo painel sem rebuild — e é também por isso que o
// prompt não pode ser o único guardião da não-alucinação: ele é editável por
// quem opera. As travas de verdade estão em evidence.ts.

import { db, registrarAuditoria } from './store/db';

export const PROMPT_PRINCIPAL_PADRAO = `Você é o assistente de operação da {EMPRESA}. Fala com TÉCNICOS de campo e do NOC, não com clientes finais. Seja direto e técnico; nada de tom comercial.

## Como você trabalha

PERGUNTA → CONSULTA ÀS FONTES → CORRELAÇÃO → RESPOSTA.

Você não sabe nada sobre a rede por conta própria. Todo dado que você afirmar precisa ter vindo de uma ferramenta nesta conversa. Se não consultou, não afirme.

## Regras que não se negociam

1. NUNCA invente SN, contrato, endereço, valor de sinal, horário ou contagem. Se a ferramenta não trouxe, o dado não existe para você.
2. Distinga "não achei" de "a fonte caiu". Se a fonte caiu, diga qual caiu.
3. Dado do espelho local (campo "origem" citando sync) é FOTO, não tempo real. Ao usar, diga a idade. Para valor atual de um cliente, chame revisao_cliente.
4. Quando localizar_cliente devolver casouPor "texto", pode ser homônimo. Liste os candidatos e pergunte qual é, em vez de escolher por conta.
5. Cite a evidência que sustenta cada afirmação usando o rótulo dela (evd_1, evd_2…). Não invente rótulo: só existem os que as ferramentas devolveram.
6. Se faltar dado para concluir, diga o que falta. Resposta incompleta e honesta vale mais que resposta completa e inventada.

## Formato obrigatório da resposta

A PRIMEIRA linha é exatamente uma destas:

VEREDITO: CONFIRMADO
VEREDITO: PROVAVEL
VEREDITO: INCONCLUSIVO

Critério:
- CONFIRMADO — os dados coletados comprovam a conclusão, sem furo.
- PROVAVEL — os dados apontam para a conclusão, mas falta comprovação.
- INCONCLUSIVO — não há dado suficiente. Este é o veredito correto quando as ferramentas não trouxeram nada. Não force uma conclusão.

Depois da primeira linha, a resposta em si. Direto ao ponto: o técnico está em campo, muitas vezes lendo no celular. Sem repetir a pergunta, sem introdução.

Formatação para WhatsApp: *negrito* com um asterisco, sem markdown de título, sem tabela. Listas curtas com •.`;

export const PROMPT_REVISAO_PADRAO = `Ao fazer revisão completa de cliente, organize nesta ordem, omitindo o que não veio das fontes (não escreva "não informado" para tudo — só cite o que faltou se for relevante para a conclusão):

*Cliente* — nome, contrato, plano, situação
*Conexão* — status, última autenticação, IP
*Óptico* — SN, RX, TX, CTO, OLT/slot/PON
*Quedas* — quantidade na janela, tempo total fora, se há queda em curso
*Rede* — incidente aberto que afete a infra dele, manutenção programada
*Conclusão* — o que isso indica

Sinal óptico: RX acima de -27 dBm é aceitável, abaixo de -27 preocupa, abaixo de -30 é crítico. Diga o número junto com a leitura.`;

export interface PromptRegistro {
  id: number;
  chave: string;
  versao: number;
  conteudo: string;
  ativo: number;
  autor: string | null;
  nota: string | null;
  criado_em: string;
}

const SEMENTES: Record<string, string> = {
  principal: PROMPT_PRINCIPAL_PADRAO,
  revisao: PROMPT_REVISAO_PADRAO,
};

/** Cria a versão 1 de cada prompt que ainda não existe no banco. */
export function semearPrompts(): void {
  const d = db();
  const existe = d.prepare(`SELECT 1 FROM prompt WHERE chave = ? LIMIT 1`);
  const inserir = d.prepare(
    `INSERT INTO prompt (chave, versao, conteudo, ativo, autor, nota, criado_em)
     VALUES (?, 1, ?, 1, 'sistema', 'semente inicial do código', ?)`,
  );
  for (const [chave, conteudo] of Object.entries(SEMENTES)) {
    if (!existe.get(chave)) inserir.run(chave, conteudo, new Date().toISOString());
  }
}

export function promptAtivo(chave: string): string {
  const r = db().prepare(
    `SELECT conteudo FROM prompt WHERE chave = ? AND ativo = 1 ORDER BY versao DESC LIMIT 1`,
  ).get(chave) as { conteudo: string } | undefined;
  return r?.conteudo ?? SEMENTES[chave] ?? '';
}

export function listarVersoes(chave: string): PromptRegistro[] {
  return db().prepare(
    `SELECT * FROM prompt WHERE chave = ? ORDER BY versao DESC`,
  ).all(chave) as PromptRegistro[];
}

export function listarChaves(): Array<{ chave: string; versoes: number; versaoAtiva: number | null }> {
  return db().prepare(
    `SELECT chave, COUNT(*) versoes,
            MAX(CASE WHEN ativo = 1 THEN versao END) versaoAtiva
     FROM prompt GROUP BY chave ORDER BY chave`,
  ).all() as Array<{ chave: string; versoes: number; versaoAtiva: number | null }>;
}

/** Cria uma nova versão e a ativa. A anterior fica no banco, para rollback. */
export function salvarPrompt(
  chave: string,
  conteudo: string,
  autor: string,
  nota?: string,
): PromptRegistro {
  const d = db();
  const anterior = promptAtivo(chave);

  const tx = d.transaction(() => {
    const max = (d.prepare(`SELECT COALESCE(MAX(versao), 0) v FROM prompt WHERE chave = ?`)
      .get(chave) as { v: number }).v;
    d.prepare(`UPDATE prompt SET ativo = 0 WHERE chave = ?`).run(chave);
    d.prepare(
      `INSERT INTO prompt (chave, versao, conteudo, ativo, autor, nota, criado_em)
       VALUES (?, ?, ?, 1, ?, ?, ?)`,
    ).run(chave, max + 1, conteudo, autor, nota ?? null, new Date().toISOString());
    return max + 1;
  });

  const versao = tx();
  registrarAuditoria(autor, 'prompt.salvar', `${chave}@v${versao}`, anterior, conteudo);

  return db().prepare(`SELECT * FROM prompt WHERE chave = ? AND versao = ?`)
    .get(chave, versao) as PromptRegistro;
}

/** Volta para uma versão anterior, ativando-a sem apagar as demais. */
export function ativarVersao(chave: string, versao: number, autor: string): boolean {
  const d = db();
  const alvo = d.prepare(`SELECT * FROM prompt WHERE chave = ? AND versao = ?`)
    .get(chave, versao) as PromptRegistro | undefined;
  if (!alvo) return false;

  const anterior = promptAtivo(chave);
  d.transaction(() => {
    d.prepare(`UPDATE prompt SET ativo = 0 WHERE chave = ?`).run(chave);
    d.prepare(`UPDATE prompt SET ativo = 1 WHERE chave = ? AND versao = ?`).run(chave, versao);
  })();

  registrarAuditoria(autor, 'prompt.ativar', `${chave}@v${versao}`, anterior, alvo.conteudo);
  return true;
}

/** Monta o system prompt final da conversa. */
export function montarSystem(empresa: string, agora: Date): string {
  const dataHora = agora.toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
  return [
    promptAtivo('principal').replace(/\{EMPRESA\}/g, empresa),
    '',
    promptAtivo('revisao'),
    '',
    `Agora são ${dataHora} (America/Fortaleza). Use isto para interpretar "hoje", "ontem" e "agora".`,
  ].join('\n');
}
