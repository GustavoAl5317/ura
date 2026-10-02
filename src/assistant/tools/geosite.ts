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
import { geosite, Viabilidade, coordenadaDe } from '../../integrations/geosite';
import { questdb, linkMapa } from '../../integrations/questdb';
import { Ferramenta, medir, ferramentas } from './base';
import { resolverCtoAmplo } from './ctos';
import { bairrosDasCtos, distanciaM, resolverBairro } from '../geografia';

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
      // Fora da janela recente não quer dizer que a caixa não existe: pode ter
      // saído da coleta. Procura na série inteira antes de dizer "não achei".
      if (!r.cto && !r.candidatas.length) {
        const historico = await questdb.ctosEmQualquerEpoca();
        r = resolverCtoAmplo(termo, historico);
      }
      if (!r.cto) {
        return {
          vazio: true,
          dados: {
            cto_procurada: termo,
            encontrada: false,
            candidatas: r.candidatas,
            instrucao: r.candidatas.length
              ? 'Mais de uma CTO com nome parecido. Mostre as opções e pergunte qual é.'
              : 'Esse nome não casa com nenhuma CTO da série. Não invente: peça o nome como está no sistema.',
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
          casou_por: r.por,
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
              ? (c.idadeMin > 1440
                ? `Esta CTO saiu da coleta: última leitura em ${c.em.slice(0, 10)}, há ${Math.round(c.idadeMin / 1440)} dias. ` +
                  'O lado do cadastro é dessa época. Se a planta ainda mostra a caixa no lugar, isso é achado: ' +
                  'ou a caixa foi retirada do coletor sem baixa na planta, ou o coletor perdeu a caixa. Diga as duas possibilidades.'
                : `A coleta desta CTO parou há ${c.idadeMin} min: o lado do cadastro é de antes, não de agora. Diga isso ao comparar.`)
              : undefined,
            fora_da_coleta_desde: c.idadeMin > 1440 ? c.em.slice(0, 10) : null,
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

// ─── Caixas de emenda ───────────────────────────────────────────────────────
//
// Caixa de emenda (CEO, "CLO" no falar do campo) é onde um cabo é fundido no
// outro: não tem cliente, não tem splitter, não aparece no QuestDB nem no SGP.
// A única fonte é a planta. Antes desta ferramenta, "quantas caixas de emenda
// na Parangaba?" virava pergunta sobre CTO, e a pessoa teve que explicar duas
// vezes o que era uma caixa de emenda.
//
// O que a planta NÃO tem: atenuação e qualidade de fusão. Isso se mede em
// campo (OTDR, power meter). A ferramenta diz isso em vez de deixar o modelo
// inventar um "fusões em bom estado".

/** fidTipoCaixaEmenda na planta: 1 = caixa de emenda, 2 = CTO, 3 = terminador, 4 = CAH, 5 = HUB. */
export const TIPO_CAIXA_EMENDA = 1;

const COLUNAS_UTEIS = /^(fid|codigo|descricao|nome|endereco|logradouro|bairro|observacao|obs|latitude|longitude|x|y|fidtipocaixaemenda|fidmodelo|modelo|capacidade|datacadastro|data_cadastro|quantidadefusoes|qtdfusoes)$/i;

const SEM_ATENUACAO =
  'A planta guarda ONDE a caixa de emenda está e o cadastro dela. Atenuação, perda por fusão e estado das ' +
  'fusões NÃO são medidos por nenhum sistema integrado: isso se mede em campo, com OTDR ou power meter. ' +
  'Diga isso; nunca diga que as fusões estão boas ou ruins.';

function textoDe(r: Record<string, unknown>, ...campos: string[]): string | null {
  for (const c of campos) {
    const chave = Object.keys(r).find((k) => k.toLowerCase() === c.toLowerCase());
    const v = chave ? r[chave] : undefined;
    if (v !== null && v !== undefined && String(v).trim()) return String(v).trim();
  }
  return null;
}

/** Bairro de um ponto pela CTO mais próxima com bairro do cadastro. Palpite, e sai rotulado. */
async function bairroPorPerto(): Promise<((lat: number, lon: number) => { bairro: string; cto: string; distancia_m: number } | null) | null> {
  if (!config.questdb.enabled) return null;
  try {
    const ctos = await questdb.ctosAtuais();
    const lugares = bairrosDasCtos(ctos).filter((b) => b.qualidade === 'exato' && b.bairro);
    const pos = new Map(ctos.map((c) => [c.cto_id, c]));
    const pontos = lugares
      .map((l) => ({ l, c: pos.get(l.cto_id)! }))
      .filter((x) => x.c && x.c.lat !== null && x.c.long !== null);
    return (lat, lon) => {
      let melhor: { bairro: string; cto: string; distancia_m: number } | null = null;
      for (const p of pontos) {
        const d = distanciaM(lat, lon, p.c.lat!, p.c.long!);
        if (d <= 1000 && (!melhor || d < melhor.distancia_m)) melhor = { bairro: p.l.bairro!, cto: p.c.nome, distancia_m: d };
      }
      return melhor;
    };
  } catch {
    return null;
  }
}

const caixasEmenda: Ferramenta = {
  nome: 'caixas_de_emenda',
  fonte: 'geosite',
  descricao:
    'Caixas de EMENDA da planta (CEO; no campo também "CLO", "caixa de fusão"): onde um cabo de fibra é ' +
    'emendado no outro. NÃO é CTO: não tem cliente nem porta. Responde "quantas caixas de emenda temos na ' +
    'Parangaba?", "onde ficam as caixas de emenda do bairro X?", "onde fica a caixa de emenda perto da ' +
    'Angola Cables, na Praia do Futuro?" (use endereco com o ponto de referência como a pessoa falou, mais ' +
    'bairro e cidade). Sem bairro nem endereço, conta a rede inteira. Traz código, mapa e o bairro (pela CTO ' +
    'mais próxima, quando a planta não informa). Atenuação e estado das fusões NÃO estão em sistema nenhum.',
  parametros: {
    type: 'object',
    properties: {
      bairro: { type: 'string', description: 'Bairro (o nome como a pessoa falou serve)' },
      endereco: { type: 'string', description: 'Endereço ou ponto de referência ("Angola Cables, Praia do Futuro, Fortaleza")' },
      raio_m: { type: 'number', description: 'Raio em metros em volta do endereço (padrão 500, máx 3000)' },
      limite: { type: 'number', description: 'Quantas listar (padrão 20, máx 100)' },
    },
    required: [],
  },
  async executar(args, ctx) {
    const endereco = typeof args.endereco === 'string' && args.endereco.trim() ? args.endereco.trim() : null;
    const bairro = typeof args.bairro === 'string' && args.bairro.trim() ? args.bairro.trim() : null;
    const limite = Math.min(100, Math.max(1, Number(args.limite) || 20));
    const raio = Math.min(3000, Math.max(50, Number(args.raio_m) || 500));

    return [await medir<Record<string, unknown>>(ctx, 'geosite', 'geosite.caixas_de_emenda', { endereco, bairro, raio }, async () => {
      const ondeFica = await bairroPorPerto();

      if (endereco) {
        const buscar = async (r: number) => (await geosite.facilidades({ endereco, raio: r, tipos: ['caixaEmenda'] }))
          .filter((x) => {
            const tipo = Number(textoDe(x, 'fidTipoCaixaEmenda'));
            return !Number.isFinite(tipo) || tipo === TIPO_CAIXA_EMENDA;
          })
          .sort((a, b) => Number(textoDe(a, 'distancia') ?? Infinity) - Number(textoDe(b, 'distancia') ?? Infinity));
        let achadas = await buscar(raio);
        // Nada no raio pedido: abre uma vez, até 3 km. "Em frente à Angola"
        // é ponto aproximado, e a caixa a 700 m é a resposta que a pessoa quer.
        let raioUsado = raio;
        if (!achadas.length && raio < 3000) {
          raioUsado = Math.min(3000, raio * 4);
          achadas = await buscar(raioUsado);
        }
        return {
          // Busca completa no raio: nenhuma caixa é resposta (sobre esse raio).
          vazio: false,
          dados: {
            referencia: endereco,
            raio_m: raioUsado,
            raio_ampliado: raioUsado !== raio
              ? `Nada a ${raio} m; a busca foi ampliada para ${raioUsado} m. Diga a distância de cada caixa.`
              : undefined,
            encontradas: achadas.length,
            nenhuma: achadas.length === 0
              ? `Nenhuma caixa de emenda na planta a até ${raioUsado} m desse ponto. Se o ponto de referência não for ` +
                'endereço conhecido pelo mapa, a localização pode ter falhado: peça a rua mais próxima.'
              : undefined,
            caixas: achadas.slice(0, limite).map((r) => {
              const p = coordenadaDe(r);
              const b = p.latitude !== undefined && ondeFica ? ondeFica(p.latitude, p.longitude!) : null;
              return {
                codigo: textoDe(r, 'codigo', 'descricao', 'tipo'),
                distancia_m: m(Number(textoDe(r, 'distancia'))),
                bairro_provavel: b?.bairro ?? null,
                mapa: p.latitude !== undefined ? linkMapa(p.latitude, p.longitude!) : null,
              };
            }),
            o_que_nao_temos: SEM_ATENUACAO,
            nota: NOTA_PLANTA,
          },
        };
      }

      const cols = await geosite.colunas('caixaEmenda').catch(() => [] as string[]);
      const colunas = cols.length
        ? cols.filter((c) => COLUNAS_UTEIS.test(c) || /geom/i.test(c))
        : ['fid', 'codigo', 'latitude', 'longitude'];
      const temTipo = cols.some((c) => c.toLowerCase() === 'fidtipocaixaemenda');
      const r = await geosite.listarTudo('caixaEmenda', {
        columns: colunas.length ? colunas : ['fid', 'codigo'],
        filter: temTipo ? `fidTipoCaixaEmenda=${TIPO_CAIXA_EMENDA}` : undefined,
      });

      const caixas = r.registros.map((reg) => {
        const p = coordenadaDe(reg);
        const daPlanta = textoDe(reg, 'bairro');
        const perto = !daPlanta && p.latitude !== undefined && ondeFica ? ondeFica(p.latitude, p.longitude!) : null;
        return {
          codigo: textoDe(reg, 'codigo', 'descricao', 'nome', 'fid'),
          endereco: textoDe(reg, 'endereco', 'logradouro'),
          bairro: daPlanta ?? perto?.bairro ?? null,
          bairro_origem: daPlanta ? 'planta' : perto ? `CTO mais próxima (${perto.cto}, ${perto.distancia_m} m)` : null,
          observacao: textoDe(reg, 'observacao', 'obs'),
          mapa: p.latitude !== undefined ? linkMapa(p.latitude, p.longitude!) : null,
        };
      });

      let lista = caixas;
      let interpretado: { pedido: string; entendido: string } | null = null;
      if (bairro) {
        const conhecidos = [...new Set(caixas.map((c) => c.bairro).filter((b): b is string => !!b))];
        const res = resolverBairro(bairro, conhecidos);
        if (!res.bairro) {
          return {
            vazio: true,
            dados: {
              bairro_pedido: bairro,
              caixas_de_emenda_na_rede: r.total ?? caixas.length,
              sem_bairro_identificado: caixas.filter((c) => !c.bairro).length,
              bairros_com_caixa_de_emenda: conhecidos.sort().slice(0, 60),
              parecidos: res.candidatos,
              instrucao:
                'Nenhuma caixa de emenda ficou identificada nesse bairro. O bairro de cada caixa vem da CTO mais ' +
                'próxima, então caixa em trecho sem CTO perto fica sem bairro. Diga isso, mostre os parecidos e ' +
                'ofereça buscar por um endereço ou ponto de referência do trecho.',
              o_que_nao_temos: SEM_ATENUACAO,
            },
          };
        }
        if (res.como !== 'exato' || res.variantes.length > 1) interpretado = { pedido: bairro, entendido: res.variantes.join(' / ') };
        lista = caixas.filter((c) => !!c.bairro && res.variantes.includes(c.bairro));
      }

      const porBairro = new Map<string, number>();
      for (const c of caixas) if (c.bairro) porBairro.set(c.bairro, (porBairro.get(c.bairro) ?? 0) + 1);
      return {
        vazio: r.registros.length === 0,
        dados: {
          caixas_de_emenda_na_rede: r.total ?? caixas.length,
          lista_completa: r.completo,
          filtro_por_tipo: temTipo ? 'só caixas de emenda (tipo 1 da planta)' : 'a planta não informou o tipo: pode incluir outras caixas',
          bairro: bairro ? lista[0]?.bairro ?? null : undefined,
          bairro_interpretado: interpretado ? {
            ...interpretado,
            instrucao: `Diga na resposta que entendeu "${interpretado.entendido}" (a pessoa disse "${interpretado.pedido}").`,
          } : undefined,
          no_bairro: bairro ? lista.length : undefined,
          por_bairro: bairro ? undefined : [...porBairro.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([b, n]) => ({ bairro: b, caixas: n })),
          sem_bairro_identificado: caixas.filter((c) => !c.bairro).length,
          caixas: lista.slice(0, limite),
          como_ler_o_bairro: 'Quando a planta não informa o bairro, ele vem da CTO mais próxima (até 1 km). É aproximado: diga isso.',
          o_que_nao_temos: SEM_ATENUACAO,
          nota: NOTA_PLANTA,
        },
      };
    })];
  },
};

export function registrarFerramentasGeosite(): void {
  if (!config.geosite.enabled) return;
  ferramentas.registrar(viabilidade, conferir, caixasEmenda);
}
