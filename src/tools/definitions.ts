import type { ToolDefinition } from '../realtime/types';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    name: 'buscar_cliente_por_cpf',
    description:
      'Busca o cadastro do cliente pelo CPF informado. Use quando o cliente fornecer o CPF para se identificar.',
    parameters: {
      type: 'object',
      properties: {
        cpf: { type: 'string', description: 'CPF do cliente com exatamente 11 dígitos numéricos, sem pontuação (ex.: "80066969000")' },
      },
      required: ['cpf'],
    },
  },
  {
    type: 'function',
    name: 'consultar_financeiro',
    description:
      'Consulta a situação financeira do cliente: faturas em aberto, valores, vencimentos e inadimplência.',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: { type: 'number', description: 'ID interno do cliente no SGP' },
      },
      required: ['cliente_id'],
    },
  },
  {
    type: 'function',
    name: 'gerar_segunda_via',
    description:
      'Gera segunda via de boleto e/ou PIX Copia e Cola para pagamento de fatura. Envia por WhatsApp se disponível.',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: { type: 'number' },
        fatura_id: { type: 'number', description: 'ID da fatura a gerar segunda via' },
        enviar_whatsapp: {
          type: 'boolean',
          description: 'Se true, envia o link por WhatsApp para o número da chamada',
        },
      },
      required: ['cliente_id', 'fatura_id'],
    },
  },
  {
    type: 'function',
    name: 'verificar_massiva',
    description:
      'Verifica se há falha massiva ativa na rede. SEMPRE use isso PRIMEIRO quando o cliente relatar falta de internet ou lentidão.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'consultar_onu',
    description:
      'Consulta o status técnico da ONU do cliente: se está online, potência óptica (sinal), uptime e modelo.',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: { type: 'number' },
      },
      required: ['cliente_id'],
    },
  },
  {
    type: 'function',
    name: 'reiniciar_onu',
    description:
      'Executa reinicialização remota da ONU do cliente. Use após confirmar que a ONU está offline ou com sinal ruim.',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: { type: 'number' },
      },
      required: ['cliente_id'],
    },
  },
  {
    type: 'function',
    name: 'abrir_chamado',
    description:
      'Abre ordem de serviço técnico no SGP. Use SOMENTE após esgotar diagnóstico remoto E o cliente confirmar que tentou as orientações (reiniciar roteador/ONU) e não funcionou. NUNCA use no mesmo turno em que orienta uma ação — aguarde a resposta do cliente.',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: { type: 'number' },
        titulo: { type: 'string', description: 'Título breve do problema' },
        descricao: {
          type: 'string',
          description:
            'Descrição detalhada: o que o cliente relatou, diagnóstico realizado, ações tentadas e resultado',
        },
      },
      required: ['cliente_id', 'titulo', 'descricao'],
    },
  },
  {
    type: 'function',
    name: 'agendar_visita_tecnica',
    description:
      'Agenda visita técnica para o cliente. Use somente após esgotar as possibilidades de resolução remota.',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: { type: 'number' },
        descricao: {
          type: 'string',
          description: 'Motivo da visita e detalhes do problema para o técnico',
        },
        periodo_preferencia: {
          type: 'string',
          enum: ['MANHA', 'TARDE'],
          description: 'Período preferido pelo cliente',
        },
      },
      required: ['cliente_id', 'descricao'],
    },
  },
  {
    type: 'function',
    name: 'desbloqueio_confianca',
    description:
      'Realiza desbloqueio de confiança para cliente inadimplente. Use somente quando o cliente solicitar e estiver dentro da política.',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: { type: 'number' },
      },
      required: ['cliente_id'],
    },
  },
  {
    type: 'function',
    name: 'verificar_viabilidade',
    description:
      'Verifica cobertura de internet fibra em um endereço. Use para consultas de novos clientes ou mudança de endereço.',
    parameters: {
      type: 'object',
      properties: {
        cep: { type: 'string', description: 'CEP do endereço (prioritário)' },
        logradouro: { type: 'string' },
        numero: { type: 'string' },
        bairro: { type: 'string' },
        cidade: { type: 'string' },
      },
    },
  },
  {
    type: 'function',
    name: 'registrar_interesse_cobertura',
    description:
      'Registra o interesse de um cliente em potencial que não tem cobertura no endereço. Use SOMENTE após verificar_viabilidade retornar sem cobertura e o cliente aceitar ser avisado quando a cobertura chegar.',
    parameters: {
      type: 'object',
      properties: {
        nome: { type: 'string', description: 'Nome completo do interessado' },
        celular: {
          type: 'string',
          description:
            'Número de celular/WhatsApp para contato (com DDD). Sempre pergunte ao cliente. Se ele não tiver ou não quiser informar, deixe em branco.',
        },
        email: { type: 'string', description: 'E-mail do interessado (opcional, não insistir se não tiver)' },
        endereco: {
          type: 'string',
          description: 'Endereço consultado no formato "Rua X, 123, Bairro, Cidade/UF, CEP"',
        },
        plano_interesse: {
          type: 'string',
          description: 'Nome ou descrição do plano que o cliente demonstrou interesse (ex: "Plano 300MB - R$ 99,90")',
        },
        melhor_horario: {
          type: 'string',
          description: 'Melhor horário para contato (ex: manhã, tarde, noite)',
        },
      },
      required: ['nome', 'endereco'],
    },
  },
  {
    type: 'function',
    name: 'consultar_planos',
    description: 'Lista os planos de internet disponíveis para contratação com preços e velocidades.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'transferir_para_atendente',
    description:
      'Transfere a chamada para um atendente humano. Use quando solicitado pelo cliente ou quando o problema não pode ser resolvido pela IA.',
    parameters: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description: 'Motivo da transferência (ex: cliente solicitou, reclamação grave, problema complexo)',
        },
        resumo: {
          type: 'string',
          description:
            'Resumo completo do atendimento para o atendente: motivo do contato, diagnóstico, ações realizadas, situação financeira, próxima ação recomendada',
        },
      },
      required: ['motivo', 'resumo'],
    },
  },
  {
    type: 'function',
    name: 'encerrar_atendimento',
    description:
      'Encerra a chamada. Use após confirmar com o cliente que o problema foi resolvido ou após despedida.',
    parameters: {
      type: 'object',
      properties: {
        motivo: {
          type: 'string',
          description: 'Como o atendimento foi concluído (ex: problema resolvido, boleto enviado)',
        },
      },
      required: ['motivo'],
    },
  },
];
