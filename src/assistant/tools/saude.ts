// Ferramenta de saúde da rede: o veredito gerencial, calculado.
//
// Existe para a pergunta de gestor: "como está a rede no bairro X?", "a PON 3
// está bem?", "tem algum problema na rede hoje?". A ferramenta devolve o nível
// já decidido (saudável, ponto de atenção, em degradação, crítico ou sem base),
// com motivo, impacto e ação. O modelo só redige — não promove nem rebaixa.

import { config } from '../../config';
import { lerSaude, lerSaudePorBairro, ROTULO_NIVEL } from '../saude-rede';
import { resumoPorBairro, enderecoDaCto, enderecoEmTexto, bairroPedido } from '../geografia';
import { lerPrioridades, filtrarBairro, reais } from '../prioridade';
import { questdb } from '../../integrations/questdb';
import { Ferramenta, medir, ferramentas } from './base';

const saude: Ferramenta = {
  nome: 'saude_da_rede',
  fonte: 'questdb',
  descricao:
    'Diz COMO ESTÁ a rede, num bairro, numa PON, numa caixa ou na rede inteira, em linguagem de gestor: ' +
    'saudável, ponto de atenção, em degradação, crítico, ou sem base para avaliar. Traz o motivo, quantos ' +
    'clientes estão em risco, desde quando e o que fazer, além das caixas que puxam o resultado para baixo. ' +
    'Responde "como está a rede no Henrique Jorge?", "a PON 3 está bem?", "tem algum problema hoje?", ' +
    '"onde estão os pontos de atenção?". ' +
    'O nível vem CALCULADO: cada caixa é comparada com o normal dela mesma (sinal da fibra), somado a ' +
    'incidentes abertos, quedas repetidas em 30 dias, lotação e falta de leitura. NÃO mude o nível, não ' +
    'chame de saudável o que veio como "sem base", e não esconda os números técnicos: mostre-os primeiro e ' +
    'depois a leitura para gestão.',
  parametros: {
    type: 'object',
    properties: {
      bairro: { type: 'string', description: 'Bairro (o nome como a pessoa falou serve)' },
      cidade: { type: 'string', description: 'Cidade' },
      pon: { type: 'string', description: 'PON, como aparece no sistema' },
      cto: { type: 'string', description: 'Uma caixa só, pelo nome' },
      por_bairro: { type: 'boolean', description: 'Um veredito por bairro, piores primeiro. Use para "onde estão os problemas?"' },
    },
    required: [],
  },
  async executar(args, ctx) {
    const f = {
      bairro: typeof args.bairro === 'string' && args.bairro.trim() ? args.bairro.trim() : undefined,
      cidade: typeof args.cidade === 'string' && args.cidade.trim() ? args.cidade.trim() : undefined,
      pon: typeof args.pon === 'string' && args.pon.trim() ? args.pon.trim() : undefined,
      cto: typeof args.cto === 'string' && args.cto.trim() ? args.cto.trim() : undefined,
    };

    return [await medir<Record<string, unknown>>(ctx, 'questdb', 'questdb.saude_da_rede', args, async () => {
      await questdb.exigirColetaViva();

      if (args.por_bairro === true) {
        const bairros = await lerSaudePorBairro();
        return {
          vazio: bairros.length === 0,
          dados: {
            bairros: bairros.slice(0, 15).map((b) => ({
              bairro: b.alvo,
              nivel: b.rotulo,
              motivo: b.motivo,
              clientes_em_risco: b.impacto.clientes_em_risco,
              caixas: b.impacto.caixas,
              o_que_fazer: b.o_que_fazer.slice(0, 2),
            })),
            por_nivel: Object.fromEntries(
              ['Crítico', 'Em degradação', 'Ponto de atenção', 'Saudável', 'Sem base para avaliar']
                .map((r) => [r, bairros.filter((b) => b.rotulo === r).length]),
            ),
            como_responder:
              'Comece pelos bairros críticos e em degradação, com motivo e clientes em risco. Depois diga quantos ' +
              'estão saudáveis. Não chame de saudável o bairro "sem base para avaliar".',
          },
        };
      }

      const r = await lerSaude(f);

      if (!r.lugar_encontrado) {
        const todas = await questdb.ctosAtuais();
        return {
          vazio: true,
          dados: {
            filtro: f,
            lugar_encontrado: false,
            bairros_conhecidos: (f.bairro || f.cidade) ? resumoPorBairro(todas).map((b) => b.bairro).slice(0, 40) : undefined,
            instrucao:
              'Nenhuma caixa nossa nesse lugar. NÃO diga que está saudável: não há o que avaliar. ' +
              'Mostre os lugares parecidos e pergunte qual é.',
          },
        };
      }

      const l = r.leitura;
      return {
        dados: {
          bairro_interpretado: r.entendido ? {
            ...r.entendido,
            instrucao: `Diga na resposta que entendeu "${r.entendido.entendido}" (a pessoa disse "${r.entendido.pedido}").`,
          } : undefined,
          leitura_para_gestao: {
            nivel: l.nivel,
            rotulo: l.rotulo,
            resumo: l.resumo,
            motivo: l.motivo,
            impacto: l.impacto,
            o_que_cada_numero_conta: {
              clientes_em_risco: 'clientes em caixas com problema de SINAL ou ESTABILIDADE (degradação ou crítico). Caixa cheia NÃO entra aqui.',
              clientes_com_atencao: 'clientes em caixas com ponto de atenção: na maioria, caixa cheia ou quase cheia, ou sem leitura. Não estão sem serviço.',
            },
            desde: l.desde,
            desde_explicacao: l.desde_explicacao,
            o_que_fazer: l.o_que_fazer,
          },
          contagem_por_nivel: Object.fromEntries(Object.entries(l.contagem).map(([k, v]) => [ROTULO_NIVEL[k as keyof typeof ROTULO_NIVEL], v])),
          pontos_de_atencao: l.pontos_de_atencao.map((c) => ({
            caixa: c.nome,
            endereco_provavel: enderecoEmTexto(enderecoDaCto({ cto_id: c.cto_id, nome: c.nome })),
            pon: c.pon,
            nivel: c.rotulo,
            motivos: c.motivos,
            clientes: c.clientes,
            sinal_atual_dbm: c.sinal_atual_dbm,
            sinal_normal_dbm: c.sinal_normal_dbm,
            piora_db: c.piora_db,
            ocupacao_pct: c.ocupacao_pct,
            incidentes_abertos: c.incidentes_abertos,
            quedas_30_dias: c.quedas_30_dias,
            o_que_fazer: c.o_que_fazer,
          })),
          regua: {
            ...l.regua,
            como_le:
              `Cada caixa é comparada com o próprio normal (média dos ${l.regua.dias_referencia} dias anteriores) ` +
              `nos últimos ${l.regua.janela_min} min. Piora de ${l.regua.limiar_db} dB ou mais é degradação; de ` +
              `${l.regua.critico_db} dB ou mais é crítica. O lugar fica em degradação com ${l.regua.degradacao_pct}% ` +
              'das caixas com problema, ou com clientes demais em risco.',
          },
          como_responder:
            'Primeiro os números técnicos que importam (sinal, piora em dB, caixas afetadas, clientes). Depois um ' +
            'parágrafo "Leitura para gestão" com: o nível exatamente como veio, o motivo, o impacto em clientes, ' +
            'desde quando (ou que o início não é conhecido) e o que fazer. Frases curtas, sem sigla sem explicação.',
        },
      };
    })];
  },
};

// ─── Prioridade de manutenção ───────────────────────────────────────────────

const prioridade: Ferramenta = {
  nome: 'prioridade_manutencao',
  fonte: 'questdb',
  dadoPessoal: true,
  descricao:
    'ONDE MANDAR EQUIPE PRIMEIRO: os bairros com clientes em risco (ligados em caixa crítica ou em ' +
    'degradação), em ordem de prioridade, organizados Bairro > Rua > Cliente, com quantos clientes e o ' +
    'VALOR MENSAL dos contratos em risco em cada bairro e rua. Responde "onde mando a equipe hoje?", ' +
    '"quais bairros estão pior?", "quanto dinheiro está em risco?", "quais ruas do Bom Sucesso precisam de ' +
    'técnico?", "quem são os clientes em risco na Granja Portugal?". Com bairro, traz as ruas e os clientes ' +
    'daquele bairro. O valor é a mensalidade dos planos com o preço do SGP: é o que está em risco, não ' +
    'prejuízo certo.',
  parametros: {
    type: 'object',
    properties: {
      bairro: { type: 'string', description: 'Só esse bairro, com ruas e clientes (o nome como a pessoa falou serve)' },
      limite: { type: 'number', description: 'Quantos bairros listar (padrão 10, máx 50)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    return [await medir<Record<string, unknown>>(ctx, 'questdb', 'prioridade.manutencao', args, async () => {
      await questdb.exigirColetaViva();
      const p = await lerPrioridades();
      const limite = Math.min(50, Math.max(1, Number(args.limite) || 10));
      const pedido = typeof args.bairro === 'string' && args.bairro.trim() ? args.bairro.trim() : null;

      let bairros = p.bairros;
      let entendido: string | null = null;
      if (pedido) {
        const f = filtrarBairro(p.bairros, pedido);
        if (!f.bairros.length) {
          // Não está na lista de risco: ou o bairro está bem, ou não existe.
          const noCadastro = bairroPedido(pedido);
          return {
            vazio: !noCadastro.bairro,
            dados: noCadastro.bairro
              ? {
                bairro: noCadastro.variantes.join(' / '),
                clientes_em_risco: 0,
                resposta: `Nenhum cliente do ${noCadastro.bairro} está em caixa crítica ou em degradação agora. ` +
                  'Isso é resposta: não precisa mandar equipe lá por problema de sinal ou queda.',
              }
              : {
                bairro_pedido: pedido,
                parecidos: noCadastro.candidatos,
                instrucao: 'Esse bairro não aparece no cadastro. Mostre os parecidos e pergunte qual é.',
              },
          };
        }
        bairros = f.bairros;
        entendido = f.entendido;
      }

      const umBairro = !!pedido;
      return {
        // Rede inteira avaliada sem nenhum bairro em risco: isso é resposta.
        vazio: p.caixas_avaliadas === 0,
        dados: {
          bairro_interpretado: entendido ? {
            pedido, entendido,
            instrucao: `Diga na resposta que entendeu "${entendido}" (a pessoa disse "${pedido}").`,
          } : undefined,
          total_na_rede: {
            bairros_com_risco: p.total.bairros,
            caixas_em_risco: p.total.caixas,
            clientes_em_risco: p.total.clientes,
            valor_mensal_em_risco: reais(p.total.valor_mensal),
          },
          nenhum_risco: p.total.bairros === 0
            ? 'Nenhuma caixa crítica ou em degradação agora: não há bairro para priorizar por sinal ou queda.'
            : undefined,
          aviso_sobre_valor: p.aviso_valor ?? undefined,
          bairros: bairros.slice(0, umBairro ? 5 : limite).map((b) => ({
            prioridade: b.prioridade,
            bairro: b.bairro,
            nivel: b.rotulo,
            motivo: b.motivo,
            caixas_com_problema: b.caixas,
            clientes_em_risco: b.clientes,
            valor_mensal_em_risco: reais(b.valor_mensal),
            ruas: b.ruas.slice(0, umBairro ? 30 : 3).map((r) => ({
              rua: r.rua,
              clientes: r.clientes,
              valor_mensal: reais(r.valor_mensal),
              caixas: r.caixas,
              // Nome de cliente só quando a pergunta é sobre um bairro.
              clientes_lista: umBairro
                ? r.lista.slice(0, 40).map((c) => ({
                  nome: c.nome, numero: c.numero, contrato: c.contrato, plano: c.plano,
                  mensalidade: c.valor !== null ? reais(c.valor) : 'sem preço no SGP',
                }))
                : undefined,
            })),
          })),
          bairros_fora_da_lista: !umBairro && bairros.length > limite ? bairros.length - limite : undefined,
          como_responder:
            'Comece pela prioridade 1: o bairro, quantos clientes e quanto por mês está em risco, e as ruas onde ' +
            'a equipe deve ir. Depois as próximas, em uma linha cada. "Em risco" = cliente ligado em caixa crítica ' +
            'ou piorando; o valor é a mensalidade dos planos, o que a casa perde se esses clientes saírem, não ' +
            'prejuízo certo. Não some nem arredonde os valores por conta própria: use os que vieram.',
        },
      };
    })];
  },
};

export function registrarFerramentasSaude(): void {
  if (!config.questdb.enabled) return;
  ferramentas.registrar(saude, prioridade);
}
