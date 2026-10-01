// De que fabricante é esse equipamento, e que tipo de equipamento ele é.
//
// O Zabbix não tem um campo "fabricante" garantido. Equipamento Huawei se
// chama NE8K, NE20, MA5800, S6730 — "huawei" quase nunca está no nome. Então a
// resposta vem, em ordem de confiança:
//   1. INVENTÁRIO do host (vendor/model), quando alguém preencheu;
//   2. TEMPLATE ligado ao host ("Huawei VRP by SNMP", "ZTE OLT...");
//   3. NOME do host, pelo padrão de modelo (NE8K → Huawei).
// A origem vai junto da resposta: "pelo nome" é palpite bem fundamentado, não
// certeza, e o técnico precisa saber a diferença.

export type OrigemFabricante = 'inventario' | 'template' | 'nome';

export interface Identificacao {
  fabricante: string | null;
  por: OrigemFabricante | null;
  modelo: string | null;
  tipo: 'olt' | 'roteador' | 'switch' | 'outro';
}

interface Regra {
  fabricante: string;
  /** Casa no texto do inventário e do template. */
  marca: RegExp;
  /** Casa no NOME do host: padrões de modelo que só esse fabricante usa. */
  modelos: RegExp[];
}

const REGRAS: Regra[] = [
  {
    fabricante: 'Huawei',
    marca: /huawei|\bvrp\b|smartax|optix/i,
    modelos: [/\bne ?(?:8000|8k|5000e?|40e?|20e?)\b/i, /\bne(?:8k|20|40)/i, /\b(?:ma|ea)5[68]\d\d/i, /\bs(?:53|57|58|63|67|68|127)\d\d/i, /\bce(?:12|68|88|58|67)\d\d/i, /\bar(?:1|2|3|6)\d{2,3}\b/i],
  },
  { fabricante: 'ZTE', marca: /\bzte\b|zxa10|zxr10/i, modelos: [/\bzxa10/i, /\bc(?:300|320|350|600|620|650)\b/i] },
  { fabricante: 'Datacom', marca: /datacom/i, modelos: [/\bdm ?\d{4}/i] },
  { fabricante: 'MikroTik', marca: /mikrotik|routeros/i, modelos: [/\bccr\d/i, /\bcrs\d/i, /\brb\d{3,4}/i] },
  { fabricante: 'Cisco', marca: /cisco|catalyst|nexus/i, modelos: [/\basr ?\d{3,4}/i, /\bnexus/i, /\bcatalyst/i] },
  { fabricante: 'Juniper', marca: /juniper|junos/i, modelos: [/\bmx ?(?:5|10|40|80|104|204|240|480|960)\b/i] },
  { fabricante: 'Fiberhome', marca: /fiberhome/i, modelos: [/\ban55\d\d/i, /\ban6000/i] },
  { fabricante: 'Nokia', marca: /nokia|alcatel/i, modelos: [/\b7750\b/i, /\bisam\b/i] },
  { fabricante: 'Ubiquiti', marca: /ubiquiti|unifi|edgerouter|airmax/i, modelos: [/\bedgerouter/i, /\bunifi/i] },
  { fabricante: 'Parks', marca: /\bparks\b|fiberlink/i, modelos: [] },
  { fabricante: 'Intelbras', marca: /intelbras/i, modelos: [] },
  { fabricante: 'V-SOL', marca: /v-?sol\b/i, modelos: [] },
  { fabricante: 'Furukawa', marca: /furukawa/i, modelos: [] },
];

export const FABRICANTES = REGRAS.map((r) => r.fabricante);

function tipoDe(texto: string): Identificacao['tipo'] {
  // Modelo é mais preciso que palavra: um S6730 é switch mesmo com "CORE" no
  // nome. Por isso modelos primeiro, palavras depois.
  if (/\bolt\b|\b(?:ma|ea)5[68]\d\d|\bzxa10|\bc(?:300|320|350|600|620|650)\b|\ban55\d\d|\bisam\b/i.test(texto)) return 'olt';
  if (/\bs(?:53|57|58|63|67|68|127)\d\d|\bce(?:12|68|88|58|67)\d\d|\bcrs\d|\bdm ?\d{4}/i.test(texto)) return 'switch';
  if (/\bne ?(?:8000|8k|5000|40|20)|\bne(?:8k|20|40)|\bccr\d|\bmx ?\d|\basr ?\d/i.test(texto)) return 'roteador';
  if (/\bsw\b|switch/i.test(texto)) return 'switch';
  if (/\bbgp\b|\bborda\b|\bcore\b|\bbng\b|\brouter\b/i.test(texto)) return 'roteador';
  return 'outro';
}

function modeloNoNome(nome: string): string | null {
  for (const r of REGRAS) {
    for (const m of r.modelos) {
      const achou = nome.match(m);
      if (achou) return achou[0].replace(/\s+/g, '').toUpperCase();
    }
  }
  return null;
}

/**
 * Identifica fabricante, modelo e tipo de um host. A origem diz quanto
 * confiar: inventário e template são declarados; nome é dedução.
 */
export function identificar(h: {
  nome: string;
  templates?: string[];
  inventario?: { vendor?: string; model?: string; os?: string; hardware?: string; type?: string; type_full?: string } | null;
}): Identificacao {
  const inv = h.inventario ?? {};
  const textoInv = [inv.vendor, inv.model, inv.os, inv.hardware, inv.type, inv.type_full].filter(Boolean).join(' ');
  const textoTpl = (h.templates ?? []).join(' ');
  const tipo = tipoDe(`${h.nome} ${textoTpl} ${textoInv}`);
  const modelo = (inv.model && inv.model.trim()) || modeloNoNome(h.nome);

  for (const [origem, texto] of [['inventario', textoInv], ['template', textoTpl]] as Array<[OrigemFabricante, string]>) {
    if (!texto) continue;
    const r = REGRAS.find((x) => x.marca.test(texto));
    if (r) return { fabricante: r.fabricante, por: origem, modelo, tipo };
  }
  const pelaMarcaNoNome = REGRAS.find((x) => x.marca.test(h.nome));
  if (pelaMarcaNoNome) return { fabricante: pelaMarcaNoNome.fabricante, por: 'nome', modelo, tipo };
  const peloModelo = REGRAS.find((x) => x.modelos.some((m) => m.test(h.nome)));
  if (peloModelo) return { fabricante: peloModelo.fabricante, por: 'nome', modelo, tipo };
  return { fabricante: null, por: null, modelo, tipo };
}

function edicao(a: string, b: string): number {
  const linha = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let anterior = linha[0];
    linha[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const guardado = linha[j];
      linha[j] = Math.min(linha[j] + 1, linha[j - 1] + 1, anterior + (a[i - 1] === b[j - 1] ? 0 : 1));
      anterior = guardado;
    }
  }
  return linha[b.length];
}

/**
 * Nome de fabricante como a pessoa escreve ("hawuei", "huawey", "mikrotic")
 * para o nome canônico. null quando não parece nenhum.
 */
export function fabricantePedido(texto: string): string | null {
  const t = texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  if (!t) return null;
  let melhor: { f: string; d: number } | null = null;
  for (const f of FABRICANTES) {
    const alvo = f.toLowerCase().replace(/[^a-z]/g, '');
    if (alvo === t || alvo.startsWith(t) && t.length >= 3) return f;
    const d = edicao(alvo, t);
    if (d <= 2 && (!melhor || d < melhor.d)) melhor = { f, d };
  }
  return melhor?.f ?? null;
}
