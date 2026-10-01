// Ferramentas do GeoSite: a planta da rede, que é a única fonte que sabe onde
// a caixa está de verdade.
//
// O cliente HTTP já existia aqui, usado pela URA para dizer se um endereço tem
// cobertura. O assistente não usava nada disso, e por isso duas perguntas
// óbvias ficavam sem resposta:
//
//   1. "Tem porta livre perto desse endereço?" — pergunta do comercial, que
//      hoje depende de alguém abrir o mapa à mão.
//   2. "O cadastro e a planta concordam sobre essa caixa?" — pergunta do NOC.
//      Cadastro desatualizado é o que faz técnico viajar para uma caixa lotada
//      achando que tinha vaga. Duas fontes discordando é achado, não detalhe.
//
// O GeoSite mede a distância do PONTO consultado até cada caixa. Então, para
// conferir uma CTO que já conhecemos, consulta-se a coordenada dela: a caixa
// com distância perto de zero é ela mesma.

import { config } from '../../config';
import { geosite, Viabilidade } from '../../integrations/geosite';
import { questdb, linkMapa } from '../../integrations/questdb';
import { Ferramenta, medir, ferramentas } from './base';
import { resolverCtoAmplo } from './ctos';

const m = (x: number | null | undefined) => (x === null || x === undefined ? null : Math.round(x));

function caixasSaida(v: Viabilidade, limite = 8) {
  return (v.caixasCobrindo ?? []).slice(0, limite).map((c) => ({
    caixa: c.tipoCodigo,
    distancia_m: m(c.distanciaMetros),
    portas_livres: c.portasDisponiveis,
    portas_livres_no_splitter: c.portasSplitterDisponiveis,
    portas_no_splitter: c.capacidadeSplitter ?? null,
    clientes_na_planta: c.clientes ?? null,
  }));
}

const NOTA_PLANTA =
  'Os números vêm da planta da rede (GeoSite), não do cadastro de clientes: é o que o projeto registra ' +
  'como instalado. Divergência com o cadastro do SGP é informação, não erro de leitura.';

/** Viabilidade: onde dá para instalar, e a que distância. */
const viabilidade: Ferramenta = {
  nome: 'viabilidade_instalacao',
  fonte: 'geosite',
  descricao:
    'Diz se um endereço, CEP ou coordenada tem cobertura de fibra, qual caixa atende, a que distância e ' +
    'quantas portas estão livres nela. Quando a caixa mais próxima está lotada, indica a próxima mais ' +
    'próxima que ainda tem porta. Responde "tem viabilidade na Rua X, 123?", "dá para instalar nesse CEP?", ' +
    '"qual caixa atende esse endereço?", "tem porta livre perto daqui?". ' +
    'Com coordenada, também diz se existe cabo óptico passando perto do ponto. ' +
    'Não sabe se o cliente pode contratar (isso é comercial e financeiro): sabe se a rede alcança o lugar.',
  parametros: {
    type: 'object',
    properties: {
      endereco: { type: 'string', description: 'Endereço completo, como se escreve ("Rua Araçá, 123, Henrique Jorge, Fortaleza")' },
      cep: { type: 'string', description: 'CEP, só os números' },
      latitude: { type: 'number', description: 'Latitude, quando houver coordenada' },
      longitude: { type: 'number', description: 'Longitude, quando houver coordenada' },
    },
    required: [],
  },
  async executar(args, ctx) {
    const endereco = typeof args.endereco === 'string' ? args.endereco.trim() : '';
    const cep = typeof args.cep === 'string' ? args.cep.replace(/\D/g, '') : '';
    const lat = typeof args.latitude === 'number' ? args.latitude : null;
    const long = typeof args.longitude === 'number' ? args.longitude : null;

    return [await medir<Record<string, unknown>>(ctx, 'geosite', 'geosite.viabilidade', args, async () => {
      if (!config.geosite.enabled) {
        throw new Error('a planta da rede (GeoSite) está desligada na configuração do servidor');
      }
      if (!endereco && !cep && (lat === null || long === null)) {
        throw new Error('informe endereço, CEP ou as duas coordenadas');
      }

      const temCoordenada = lat !== null && long !== null;
      const v = temCoordenada
        ? await geosite.viabilidadePorCoordenadas(lat!, long!)
        : endereco
          ? await geosite.viabilidadePorEndereco(endereco)
          : await geosite.viabilidadePorCep(cep);

      const cabo = temCoordenada ? await geosite.existeLanceCabo(lat!, long!) : null;
      const alvo = endereco || (cep ? `CEP ${cep}` : `${lat}, ${long}`);

      if (!v.caixasProximas) {
        return {
          vazio: true,
          dados: {
            alvo,
            tem_cobertura: false,
            caixas_no_raio: 0,
            raio_consultado_m: config.geosite.raioMetros,
            existe_cabo_proximo: cabo,
            instrucao:
              'Nenhuma caixa dentro do raio consultado. Isso NÃO prova que o endereço é inatendível: ' +
              'pode ser endereço mal escrito ou fora do raio. Diga o raio usado e, se houver cabo perto, ' +
              'diga que há rede na região sem caixa com porta.',
          },
        };
      }

      return {
        dados: {
          alvo,
          raio_consultado_m: config.geosite.raioMetros,
          tem_cobertura: v.temCobertura,
          caixas_no_raio: v.caixasProximas,
          portas_livres_no_raio: v.totalDisponiveis ?? 0,
          caixa_indicada: v.caixaSelecionada ? {
            caixa: v.caixaSelecionada.tipoCodigo,
            distancia_m: m(v.caixaSelecionada.distanciaMetros),
            portas_livres: v.caixaSelecionada.portasDisponiveis,
            portas_livres_no_splitter: v.caixaSelecionada.portasSplitterDisponiveis,
            portas_no_splitter: v.caixaSelecionada.capacidadeSplitter ?? null,
            clientes_na_planta: v.caixaSelecionada.clientes ?? null,
            mapa: v.caixaSelecionada.latitude !== undefined && v.caixaSelecionada.longitude !== undefined
              ? linkMapa(v.caixaSelecionada.latitude, v.caixaSelecionada.longitude) : null,
          } : null,
          outras_caixas_no_raio: caixasSaida(v),
          existe_cabo_proximo: cabo,
          nota: v.temCobertura
            ? NOTA_PLANTA
            : `Há ${v.caixasProximas} caixa(s) no raio, TODAS sem porta livre. Isso é falta de porta, não falta de rede: a saída é ampliar a caixa, não recusar o endereço. ${NOTA_PLANTA}`,
        },
      };
    })];
  },
};

/** Cadastro contra planta, na mesma caixa. */
const conferir: Ferramenta = {
  nome: 'conferir_caixa_na_planta',
  fonte: 'geosite',
  descricao:
    'Confere uma CTO na planta da rede (GeoSite) e compara com o cadastro: portas livres em cada fonte e ' +
    'a diferença entre elas. Responde "a CTO 7 tem porta livre de verdade?", "o cadastro dessa caixa está ' +
    'certo?", "quantas portas sobram na caixa tal?". ' +
    'Use antes de mandar técnico instalar numa caixa que o cadastro diz ter vaga: cadastro desatualizado é ' +
    'o que faz a viagem perdida. Quando as duas fontes discordam, diga os dois números e que a planta é o ' +
    'que o projeto registra como instalado.',
  parametros: {
    type: 'object',
    properties: {
      cto: { type: 'string', description: 'Nome ou número da CTO, como o técnico fala' },
      raio_m: { type: 'number', description: 'Raio da busca em volta da coordenada da CTO (padrão 120 m)' },
    },
    required: ['cto'],
  },
  async executar(args, ctx) {
    const termo = String(args.cto ?? '').trim();
    const raio = Math.min(500, Math.max(30, Number(args.raio_m) || 120));

    return [await medir<Record<string, unknown>>(ctx, 'geosite', 'geosite.conferir_caixa', args, async () => {
      if (!config.geosite.enabled) {
        throw new Error('a planta da rede (GeoSite) está desligada na configuração do servidor');
      }
      if (!termo) throw new Error('diga qual CTO conferir');

      const todas = await questdb.ctosAtuais();
      let r = resolverCtoAmplo(termo, todas);
      let doHistorico = false;
      let historicoFalhou: string | null = null;
      if (!r.cto && !r.candidatas.length) {
        // A CTO pode ter parado de ser coletada antes da janela e continuar na
        // rua. A série inteira é cara de ler, por isso só aqui, no "não achei".
        const historico = await questdb.ctosHistorico().catch((err: Error) => {
          historicoFalhou = err.message;
          return [] as typeof todas;
        });
        const r2 = resolverCtoAmplo(termo, historico);
        if (r2.cto || r2.candidatas.length) {
          r = r2;
          doHistorico = true;
        } else if (!r.parecidas.length) {
          r = { ...r, parecidas: r2.parecidas };
        }
      }
      if (!r.cto) {
        return {
          vazio: true,
          dados: {
            cto_procurada: termo,
            encontrada: false,
            candidatas: r.candidatas,
            parecidas: r.parecidas,
            ctos_na_serie: todas.length,
            historico_indisponivel: historicoFalhou ?? undefined,
            instrucao: r.candidatas.length
              ? 'Mais de uma CTO com nome parecido. Mostre as opções e pergunte qual é.'
              : r.parecidas.length
                ? 'Nenhuma CTO tem todas as palavras desse nome, mas estas têm parte dele. Mostre e pergunte se é ' +
                  'uma delas. Não escolha por conta própria.'
                : `Esse nome não casa com nenhuma CTO da série${historicoFalhou ? '' : ', nem no histórico'}. Não invente. Peça o nome como está ` +
                  'no sistema, ou o endereço da caixa: com o endereço, viabilidade_instalacao mostra as caixas da ' +
                  'planta por perto, com o nome de cada uma.',
          },
        };
      }
      const c = r.cto;
      if (c.lat === null || c.long === null) {
        return {
          vazio: true,
          dados: {
            cto: c.nome, encontrada: true, sem_coordenada: true,
            instrucao: 'Essa CTO não tem coordenada na série, então não dá para localizá-la na planta. Diga isso.',
          },
        };
      }

      const v = await geosite.viabilidadePorCoordenadas(c.lat, c.long);
      const lista = (v.caixasCobrindo ?? []).filter((x) => x.distanciaMetros <= raio);
      // A caixa no próprio ponto é a mais perto; acima do raio já é vizinha.
      const naPlanta = lista[0] ?? null;

      const livresCadastro = c.portas !== null && c.clientes !== null ? Math.max(0, c.portas - c.clientes) : null;
      const livresPlanta = naPlanta?.portasDisponiveis ?? null;
      const diferenca = livresCadastro !== null && livresPlanta !== null ? livresPlanta - livresCadastro : null;

      return {
        dados: {
          cto: c.nome,
          casou_por: doHistorico ? `${r.por} (histórico da série)` : r.por,
          pon: c.pon,
          mapa: linkMapa(c.lat, c.long),
          cadastro: {
            clientes: c.clientes,
            portas: c.portas,
            portas_livres: livresCadastro,
            ocupacao_pct: c.ocupacao,
            leitura_em: c.em,
            leitura_ha_min: c.idadeMin,
            sem_leitura_recente: c.semLeituraRecente,
            aviso: c.semLeituraRecente
              ? `A coleta desta CTO parou há ${c.idadeMin} min: o lado do cadastro é de antes, não de agora. Diga isso ao comparar.`
              : undefined,
          },
          planta: naPlanta ? {
            caixa: naPlanta.tipoCodigo,
            distancia_m: m(naPlanta.distanciaMetros),
            portas_livres: naPlanta.portasDisponiveis,
            portas_livres_no_splitter: naPlanta.portasSplitterDisponiveis,
            portas_no_splitter: naPlanta.capacidadeSplitter ?? null,
            clientes: naPlanta.clientes ?? null,
            coordenada_oficial: naPlanta.latitude !== undefined && naPlanta.longitude !== undefined
              ? linkMapa(naPlanta.latitude, naPlanta.longitude) : null,
          } : null,
          vizinhas_no_raio: lista.slice(1, 6).map((x) => ({
            caixa: x.tipoCodigo, distancia_m: m(x.distanciaMetros), portas_livres: x.portasDisponiveis,
          })),
          comparacao: naPlanta ? {
            diferenca_de_portas_livres: diferenca,
            clientes_cadastro: c.clientes,
            clientes_planta: naPlanta.clientes ?? null,
            diferenca_de_clientes: naPlanta.clientes !== undefined && c.clientes !== null
              ? naPlanta.clientes - c.clientes : null,
            concordam: diferenca === 0,
            leitura: diferenca === null
              ? 'Falta dado de porta em uma das fontes: não afirme que concordam.'
              : diferenca === 0
                ? 'Cadastro e planta dizem o mesmo número de portas livres.'
                : diferenca > 0
                  ? `A planta mostra ${diferenca} porta(s) livre(s) a MAIS que o cadastro. Pode ser cadastro atrasado ou cliente desligado sem baixa.`
                  : `A planta mostra ${Math.abs(diferenca)} porta(s) livre(s) a MENOS que o cadastro. Risco de mandar técnico para uma caixa sem vaga.`,
          } : {
            diferenca_de_portas_livres: null,
            concordam: false,
            leitura: `Nenhuma caixa na planta dentro de ${raio} m da coordenada desta CTO. Pode ser coordenada errada na série ou caixa não lançada na planta — diga as duas possibilidades, sem escolher uma.`,
          },
          nota: NOTA_PLANTA,
        },
      };
    })];
  },
};

export function registrarFerramentasGeosite(): void {
  if (!config.geosite.enabled) return;
  ferramentas.registrar(viabilidade, conferir);
}
