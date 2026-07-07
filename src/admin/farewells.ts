import fs from 'fs';
import path from 'path';
import { logger } from '../logger';

export type FarewellCategory = 'geral' | 'vendas' | 'suporte' | 'financeiro';

export interface Farewell {
  id: FarewellCategory;
  label: string;
  message: string;
  enabled: boolean;
}

const STATE_FILE = path.join(process.cwd(), 'data', 'ura-farewells.json');

const CATEGORY_LABELS: Record<FarewellCategory, string> = {
  geral: 'Geral (padrão)',
  vendas: 'Vendas / Contratação',
  suporte: 'Suporte Técnico',
  financeiro: 'Financeiro',
};

const DEFAULTS: Farewell[] = [
  {
    id: 'geral',
    label: CATEGORY_LABELS.geral,
    message: 'A {empresa} agradece o seu contato! Tenha {saudacao}!',
    enabled: true,
  },
  {
    id: 'vendas',
    label: CATEGORY_LABELS.vendas,
    message: 'A {empresa} agradece por nos escolher! Nossa equipe entra em contato em breve. Tenha {saudacao}!',
    enabled: true,
  },
  {
    id: 'suporte',
    label: CATEGORY_LABELS.suporte,
    message: 'A {empresa} agradece o contato e já está cuidando do seu atendimento. Tenha {saudacao}!',
    enabled: true,
  },
  {
    id: 'financeiro',
    label: CATEGORY_LABELS.financeiro,
    message: 'A {empresa} agradece o contato! Estamos à disposição para o que precisar. Tenha {saudacao}!',
    enabled: true,
  },
];

const VALID_IDS = DEFAULTS.map((f) => f.id);

function cloneDefaults(): Farewell[] {
  return DEFAULTS.map((f) => ({ ...f }));
}

let farewells: Farewell[] = cloneDefaults();

/** Garante que todas as categorias existam, preservando os textos salvos. */
function mergeWithDefaults(saved: Farewell[]): Farewell[] {
  return DEFAULTS.map((def) => {
    const found = saved.find((s) => s.id === def.id);
    if (!found) return { ...def };
    return {
      id: def.id,
      label: CATEGORY_LABELS[def.id],
      message: typeof found.message === 'string' && found.message.trim() ? found.message : def.message,
      enabled: found.enabled !== false,
    };
  });
}

function loadFarewells(): void {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { farewells?: Farewell[] };
      if (Array.isArray(raw.farewells)) {
        farewells = mergeWithDefaults(raw.farewells);
        return;
      }
    }
  } catch (err) {
    logger.error('Erro ao carregar ura-farewells.json', err);
  }
  farewells = cloneDefaults();
}

function persistFarewells(): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify({ farewells, updatedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

loadFarewells();

export function getAllFarewells(): Farewell[] {
  return farewells;
}

export function setFarewells(incoming: Farewell[]): Farewell[] {
  const safe = Array.isArray(incoming) ? incoming.filter((f) => VALID_IDS.includes(f.id)) : [];
  farewells = mergeWithDefaults(safe);
  persistFarewells();
  logger.info(`Despedidas atualizadas: ${farewells.filter((f) => f.enabled).length} ativa(s).`);
  return farewells;
}

/**
 * Monta o bloco de despedidas para o prompt, substituindo {empresa} e {saudacao}.
 * Retorna apenas as categorias ativas; a "geral" é sempre o fallback.
 */
export function buildFarewellPromptBlock(empresa: string, saudacao: string): string {
  const resolve = (msg: string): string =>
    msg.replace(/\{empresa\}/gi, empresa).replace(/\{saudacao\}/gi, saudacao).trim();

  const byId = (id: FarewellCategory): Farewell | undefined =>
    farewells.find((f) => f.id === id && f.enabled);

  const geral = byId('geral') ?? DEFAULTS[0];
  const linhas: string[] = [];

  const vendas = byId('vendas');
  const suporte = byId('suporte');
  const financeiro = byId('financeiro');

  if (vendas) linhas.push(`• Se o atendimento foi de VENDAS/CONTRATAÇÃO: "${resolve(vendas.message)}"`);
  if (suporte) linhas.push(`• Se o atendimento foi de SUPORTE TÉCNICO: "${resolve(suporte.message)}"`);
  if (financeiro) linhas.push(`• Se o atendimento foi FINANCEIRO (fatura/2ª via/PIX): "${resolve(financeiro.message)}"`);
  linhas.push(`• Em qualquer outro caso (ou dúvida geral): "${resolve(geral.message)}"`);

  return linhas.join('\n');
}
