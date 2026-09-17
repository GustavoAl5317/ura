// Texto de tela → texto para FALAR, em português do Brasil.
//
// O TTS lê "1.157" como "um ponto cento e cinquenta e sete", "16/09" como
// "dezesseis barra zero nove" e "2026-09-16T21:33:00-03:00" como uma sopa de
// dígitos. Aqui tudo isso vira palavra ANTES de chegar ao modelo de voz:
// número por extenso, data com o nome do mês, hora como se fala, unidade por
// extenso, sigla soletrada. Determinístico e testável — um modelo reescrevendo
// a resposta para fala é o jeito mais barato de trocar um número.

const UNIDADES = ['zero', 'um', 'dois', 'três', 'quatro', 'cinco', 'seis', 'sete', 'oito', 'nove',
  'dez', 'onze', 'doze', 'treze', 'quatorze', 'quinze', 'dezesseis', 'dezessete', 'dezoito', 'dezenove'];
const DEZENAS = ['', '', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta', 'setenta', 'oitenta', 'noventa'];
const CENTENAS = ['', 'cento', 'duzentos', 'trezentos', 'quatrocentos', 'quinhentos', 'seiscentos',
  'setecentos', 'oitocentos', 'novecentos'];
const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto',
  'setembro', 'outubro', 'novembro', 'dezembro'];

function ate999(n: number, feminino: boolean): string {
  if (n === 100) return 'cem';
  const c = Math.floor(n / 100);
  const resto = n % 100;
  const partes: string[] = [];
  if (c) partes.push(feminino ? CENTENAS[c].replace(/os$/, 'as') : CENTENAS[c]);
  if (resto) {
    if (resto < 20) partes.push(fem(UNIDADES[resto], feminino));
    else {
      const d = Math.floor(resto / 10);
      const u = resto % 10;
      partes.push(u ? `${DEZENAS[d]} e ${fem(UNIDADES[u], feminino)}` : DEZENAS[d]);
    }
  }
  return partes.join(' e ');
}

function fem(palavra: string, feminino: boolean): string {
  if (!feminino) return palavra;
  return palavra === 'um' ? 'uma' : palavra === 'dois' ? 'duas' : palavra;
}

/** Inteiro por extenso ("mil cento e cinquenta e sete"). `feminino` para "duas horas", "uma CTO". */
export function extenso(n: number, feminino = false): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `menos ${extenso(-n, feminino)}`;
  n = Math.floor(n);
  if (n < 1000) return n === 0 ? 'zero' : ate999(n, feminino);

  const grupos: number[] = [];
  for (let x = n; x > 0; x = Math.floor(x / 1000)) grupos.push(x % 1000);
  const nomes: Array<[string, string]> = [['', ''], ['mil', 'mil'], ['milhão', 'milhões'], ['bilhão', 'bilhões'], ['trilhão', 'trilhões']];
  if (grupos.length > nomes.length) return String(n);

  const partes: Array<{ texto: string; valor: number }> = [];
  for (let i = grupos.length - 1; i >= 0; i--) {
    const g = grupos[i];
    if (!g) continue;
    // "mil" e não "um mil"; milhão é masculino mesmo quando a contagem é feminina.
    const num = i === 1 && g === 1 ? '' : ate999(g, i === 0 ? feminino : i === 1 ? feminino : false);
    const nome = i === 0 ? '' : g === 1 ? nomes[i][0] : nomes[i][1];
    partes.push({ texto: [num, nome].filter(Boolean).join(' '), valor: g });
  }
  // "e" antes do último grupo quando ele é < 100 ou centena redonda: "mil e cinco", "mil e duzentos".
  return partes.map((p, i) => {
    if (i === 0) return p.texto;
    const ultimo = i === partes.length - 1;
    const usaE = ultimo && (p.valor < 100 || p.valor % 100 === 0);
    return `${usaE ? 'e ' : ''}${p.texto}`;
  }).join(' ').replace(/\s+/g, ' ');
}

/** "23.18" / "23,18" → "vinte e três vírgula dezoito"; zeros à esquerda da fração são lidos. */
function decimal(inteiro: string, fracao: string, feminino = false): string {
  const fr = fracao.replace(/0+$/, '');
  const base = extenso(Number(inteiro), feminino);
  if (!fr) return base;
  const zeros = fr.match(/^0*/)![0].length;
  const resto = fr.slice(zeros);
  return `${base} vírgula ${[...Array(zeros)].map(() => 'zero').concat(resto ? [extenso(Number(resto))] : []).join(' ')}`;
}

function digitoADigito(s: string): string {
  return s.split('').map((d) => UNIDADES[Number(d)]).join(' ');
}

function hora(h: number, m: number): string {
  const hh = h === 0 ? 'meia-noite' : h === 12 && m === 0 ? 'meio-dia' : `${extenso(h, true)} ${h === 1 ? 'hora' : 'horas'}`;
  if (!m) return hh;
  return `${hh} e ${extenso(m, false)}`;
}

function data(dia: number, mes: number, ano: number | null, anoAtual: number): string | null {
  if (mes < 1 || mes > 12 || dia < 1 || dia > 31) return null;
  const d = dia === 1 ? 'primeiro' : extenso(dia);
  const a = ano && ano !== anoAtual ? ` de ${extenso(ano)}` : '';
  return `${d} de ${MESES[mes - 1]}${a}`;
}

/** Siglas que o TTS lê como palavra ("cto" → "cetô"). Soletradas como se fala no NOC. */
const SIGLAS: Array<[RegExp, string]> = [
  [/\bCTOs\b/g, 'cê tê ós'],
  [/\bCTO\b/g, 'cê tê ó'],
  [/\bOLTs\b/g, 'ó éle tês'],
  [/\bOLT\b/g, 'ó éle tê'],
  [/\bONUs\b/g, 'ônus'],
  [/\bONU\b/g, 'ônu'],
  [/\bONT\b/g, 'ó ene tê'],
  [/\bPONs\b/g, 'pons'],
  [/\bSGP\b/g, 'ésse gê pê'],
  [/\bPPPoE\b/gi, 'pê pê pê ó é'],
  [/\bNOC\b/g, 'nóc'],
  [/\bIPv6\b/gi, 'i pê vê seis'],
  [/\bIPv4\b/gi, 'i pê vê quatro'],
  [/\bIPs\b/g, 'i pês'],
  [/\bIP\b/g, 'i pê'],
  [/\bSNs?\b/g, 'número de série'],
  [/\bRX\b/g, 'érre xis'],
  [/\bTX\b/g, 'tê xis'],
  [/\bASN\b/g, 'á ésse ene'],
  [/\bURA\b/g, 'ura'],
  [/\bSLA\b/g, 'ésse éle á'],
  [/\bNetFlow\b/gi, 'nét flou'],
  [/\bZabbix\b/gi, 'zábix'],
];

const UNIDADE: Record<string, [string, string]> = {
  mbps: ['megabit por segundo', 'megabits por segundo'],
  gbps: ['gigabit por segundo', 'gigabits por segundo'],
  kbps: ['kilobit por segundo', 'kilobits por segundo'],
  tbps: ['terabit por segundo', 'terabits por segundo'],
  kb: ['kilobyte', 'kilobytes'],
  mb: ['megabyte', 'megabytes'],
  gb: ['gigabyte', 'gigabytes'],
  tb: ['terabyte', 'terabytes'],
  dbm: ['dê bê ême', 'dê bê ême'],
  db: ['decibel', 'decibéis'],
  ms: ['milissegundo', 'milissegundos'],
  min: ['minuto', 'minutos'],
  seg: ['segundo', 'segundos'],
  s: ['segundo', 'segundos'],
  h: ['hora', 'horas'],
  '%': ['por cento', 'por cento'],
};

const UNIDADE_RE = '(Mbps|Gbps|Kbps|Tbps|dBm|dB|KB|MB|GB|TB|ms|min|seg|%)';

export function textoParaFala(texto: string, agora = new Date()): string {
  const anoAtual = Number(new Intl.DateTimeFormat('en', { timeZone: 'America/Fortaleza', year: 'numeric' }).format(agora));
  let t = texto;

  // ── Estrutura da resposta de tela ──────────────────────────────────────────
  t = t
    .replace(/_Fontes:_[\s\S]*$/m, '')
    .replace(/\s*\(?\bevd_\d+(\s*[,e]\s*evd_\d+)*\)?/gi, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/🟢\s*\*?CONFIRMADO\*?/gi, '')
    .replace(/🟡\s*\*?PROV[ÁA]VEL\*?/gi, 'Ainda não está confirmado.')
    .replace(/🔴\s*\*?INCONCLUSIVO\*?/gi, 'Não consegui confirmar.')
    .replace(/⚠️/g, 'Atenção:')
    .replace(/[*_`~]/g, '')
    .replace(/^\s*[•\-–]\s*/gm, '')
    .replace(/\s+[—–]\s+/g, ': ')
    // Emoji e pictogramas restantes.
    .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '');

  // ── Data e hora ────────────────────────────────────────────────────────────
  // ISO completo: 2026-09-16T21:33:00-03:00 → "16 de setembro, às 21 e 33".
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?\b/g,
    (m, a, me, d, h, mi) => {
      const dt = data(+d, +me, +a, anoAtual);
      return dt ? `${dt}, às ${hora(+h, +mi)}` : m;
    });
  t = t.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, a, me, d) => data(+d, +me, +a, anoAtual) ?? m);
  // Porta de OLT (0/1/8, 1/8) não é data: lida com "barra".
  const porta = (n: string) => n.split('/').map((x) => extenso(Number(x))).join(' barra ');
  t = t.replace(/\b(PON|GPON|porta|slot)(\s+)(\d{1,2}(?:\/\d{1,2}){1,2})\b/gi, (_m, p, esp, n) => `${p}${esp}${porta(n)}`);
  t = t.replace(/\b0\/\d{1,2}(?:\/\d{1,2})?\b/g, porta);
  // 16/09/2026, 16/09/26, 16/09
  t = t.replace(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g, (m, d, me, a) => {
    const ano = a ? (a.length === 2 ? 2000 + Number(a) : Number(a)) : null;
    return data(+d, +me, ano, anoAtual) ?? m;
  });
  // Amostragem "1:1024" não é hora.
  t = t.replace(/\b1:(\d{3,})\b/g, (_m, n) => `um para ${extenso(Number(n))}`);
  // "às 21:33", "21:33:10", "21h33"; "24h" e "3h" sozinhos são duração.
  t = t.replace(/\b([01]?\d|2[0-3]):([0-5]\d)(?::[0-5]\d)?\b/g, (_m, h, mi) => hora(+h, +mi));
  t = t.replace(/\b([01]?\d|2[0-3])h([0-5]\d)\b/g, (_m, h, mi) => hora(+h, +mi));
  t = t.replace(/\b(\d+)\s?h\b/g, (_m, h) => `${extenso(Number(h), true)} ${Number(h) === 1 ? 'hora' : 'horas'}`);
  // \b não funciona antes de letra acentuada em JS: o limite é o espaço.
  t = t.replace(/(^|\s)às (meia-noite)/g, '$1à $2').replace(/(^|\s)às (meio-dia)/g, '$1ao $2');

  // ── Siglas ─────────────────────────────────────────────────────────────────
  t = t.replace(/\bO\.?S\.?(?=\s*(?:n[ºo°]\.?\s*)?\d)/g, 'ordem de serviço')
    .replace(/\bO\.S\.(?=\s|$|[,;:!?)])/g, 'ordens de serviço')
    .replace(/\bO\.S\b/g, 'ordens de serviço');
  for (const [re, fala] of SIGLAS) t = t.replace(re, fala);

  // ── Números ────────────────────────────────────────────────────────────────
  // IP: "177.10.20.30" → "cento e setenta e sete, ponto, dez..."; IP mascarado ".x".
  t = t.replace(/\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}|x)\b/g,
    (_m, ...p: string[]) => p.slice(0, 4).map((x) => (x === 'x' ? 'xis' : extenso(Number(x)))).join(' ponto '));
  // Negativo com unidade ou decimal: sinal óptico. O TTS engole o "-".
  t = t.replace(/(^|[\s(:])[-−](?=\d)/g, '$1menos ');
  // Milhar com ponto (pt-BR): 1.157 / 12.345.678 — exatamente grupos de 3.
  // Com unidade, só tira o ponto (a regra da unidade lê); sem unidade, vira
  // palavra já aqui — sem o ponto, pareceria identificador de 5+ dígitos.
  t = t.replace(new RegExp(`\\b(\\d{1,3}(?:\\.\\d{3})+)(?![.,]?\\d)(\\s?${UNIDADE_RE})?`, 'g'),
    (_m, n: string, u?: string) => (u ? `${n.replace(/\./g, '')}${u}` : extenso(Number(n.replace(/\./g, '')))));
  // Decimal com unidade: "23,18 dBm", "2.09 Gbps", "12,5%".
  t = t.replace(new RegExp(`\\b(\\d+)(?:[.,](\\d+))?\\s?${UNIDADE_RE}(?![\\wÀ-ú])`, 'g'), (_m, i, f, u) => {
    const nomes = UNIDADE[u.toLowerCase()] ?? [u, u];
    const um = !f && Number(i) === 1;
    const fem = u.toLowerCase() === 'h';
    return `${f ? decimal(i, f) : extenso(Number(i), fem)} ${um ? nomes[0] : nomes[1]}`;
  });
  // Decimal solto.
  t = t.replace(/\b(\d+)[.,](\d+)\b/g, (_m, i, f) => decimal(i, f));
  // Inteiro com 5+ dígitos sem separador é identificador (contrato, protocolo): dígito a dígito.
  t = t.replace(/\b\d{5,}\b/g, (m) => digitoADigito(m));
  // Identificador alfanumérico (SN "RCMG19c050ca"): letras e dígitos separados, para dar para anotar.
  t = t.replace(/\b(?=[A-Za-z]*\d)(?=\d*[A-Za-z])[A-Za-z0-9]{8,}\b/g,
    (m) => m.split('').map((c) => (/\d/.test(c) ? UNIDADES[Number(c)] : c.toUpperCase())).join(' '));
  // Inteiros restantes.
  t = t.replace(/\b\d{1,4}\b/g, (m) => extenso(Number(m)));

  // ── Sobra ──────────────────────────────────────────────────────────────────
  return t
    .replace(/\(\s*[,;:]?\s*\)/g, '')
    .replace(/\s+([,.;:!?])/g, '$1')
    .replace(/([,;:])\1+/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\s*[,.;:]\s*/gm, '')
    .trim();
}
