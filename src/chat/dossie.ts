// Dossiê do cliente exibido no painel (cadastro, financeiro, ONU). Extraído de
// ChatSession.detalhe() para ser reaproveitado também em conversas ENCERRADAS,
// que não têm sessão viva em memória — só o ctx_json salvo no banco.

import type { CallContext } from '../session/context';

export interface Dossie {
  cliente: {
    nome: string;
    cpf: string;
    confirmado: boolean;
    contratoId: number | null;
    totalContratos: number;
    status: string | null;
    motivoStatus: string | null;
    plano: string | null;
    endereco: string | null;
    telefones: string[];
  } | null;
  financeiro: {
    consultado: boolean;
    bloqueado: boolean;
    faturasAbertas: number | null;
  };
  onu: {
    status: string;
    sinalRx: unknown;
    olt: unknown;
    cto: string | null;
  } | null;
  massivaAtiva?: boolean;
  protocolos?: string[];
  transferMotivo: string | null;
}

export function montarDossie(ctx: Partial<CallContext>): Dossie {
  const c = ctx.cliente;
  const contrato = c?.contratoId
    ? c.contratos.find((ct) => ct.contrato === c.contratoId) ?? c.contratos[0]
    : c?.contratos[0];

  return {
    cliente: c
      ? {
          nome: c.nome,
          cpf: c.cpfcnpj,
          confirmado: ctx.clienteConfirmado === true,
          contratoId: c.contratoId ?? null,
          totalContratos: c.contratos.length,
          status: contrato?.status ?? null,
          motivoStatus: contrato?.motivo_status ?? null,
          plano: contrato?.servicos[0]?.plano?.descricao ?? null,
          endereco: c.endereco
            ? [c.endereco.logradouro, c.endereco.numero, c.endereco.bairro, c.endereco.cidade]
                .filter(Boolean).join(', ')
            : null,
          telefones: c.telefones ?? [],
        }
      : null,
    financeiro: {
      consultado: ctx.consultaFinanceiraFeita === true,
      bloqueado: ctx.financeiroBloqueado === true,
      faturasAbertas: ctx.titulos?.length ?? null,
    },
    onu: ctx.onu
      ? {
          status: ctx.onu.conexao?.status ?? 'desconhecido',
          sinalRx: ctx.onu.rx,
          olt: ctx.onu.olt_nome,
          cto: ctx.onu.cto_nome ?? ctx.onu.caixa ?? null,
        }
      : null,
    massivaAtiva: ctx.massivaAtiva,
    protocolos: ctx.protocolos,
    transferMotivo: ctx.transferMotivo ?? null,
  };
}
