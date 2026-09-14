// Utilitários HTTP compartilhados pelas rotas do assistente.

import http from 'http';

export type Rota = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  caminho: string,
) => Promise<boolean>;

export function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function lerCorpo(req: http.IncomingMessage, maxBytes = 8 * 1024 * 1024): Promise<string> {
  return lerBytes(req, maxBytes).then((b) => b.toString('utf8'));
}

export function lerBytes(req: http.IncomingMessage, maxBytes = 25 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const partes: Buffer[] = [];
    let bytes = 0;
    req.on('data', (c: Buffer) => {
      bytes += c.length;
      if (bytes > maxBytes) {
        reject(new Error('corpo grande demais'));
        req.destroy();
        return;
      }
      partes.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(partes)));
    req.on('error', reject);
  });
}

export async function lerJson<T = Record<string, unknown>>(req: http.IncomingMessage): Promise<T> {
  const texto = await lerCorpo(req);
  if (!texto.trim()) return {} as T;
  try {
    return JSON.parse(texto) as T;
  } catch {
    throw new ErroHttp(400, 'JSON inválido no corpo da requisição');
  }
}

/** Erro com status — a rota lança, o servidor responde com o status certo. */
export class ErroHttp extends Error {
  constructor(public readonly status: number, mensagem: string) {
    super(mensagem);
  }
}

/** Quem está chamando, para gravar na auditoria. Painel manda no header. */
export function ator(req: http.IncomingMessage): string {
  const h = req.headers['x-operador'];
  const nome = (Array.isArray(h) ? h[0] : h)?.trim();
  return nome ? `painel:${nome.slice(0, 60)}` : 'painel';
}
