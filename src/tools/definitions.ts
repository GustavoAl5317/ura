import type { ToolDefinition } from '../realtime/types';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    name: 'buscar_cliente_por_cpf',
    description:
      'Busca o cadastro pelo CPF. Após encontrar, confirme o titular (nome no contrato) com o cliente antes de usar outras ferramentas.',
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
      'Consulta situação financeira do contrato. Só use APÓS buscar_cliente_por_cpf e confirmar_titular_contrato.',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: {
          type: 'number',
          description: 'ID do CONTRATO no SGP (campo contrato_id retornado por buscar_cliente_por_cpf). Pode omitir se o cliente já foi identificado nesta chamada.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'gerar_segunda_via',
    description:
      'Gera segunda via de boleto e/ou PIX de UMA fatura. Sem fatura_id: usa automaticamente a vencida (corte/suspensão). Se não houver vencida, retorna faturas_disponiveis — pergunte ao cliente qual quer e chame de novo com fatura_id.',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: {
          type: 'number',
          description: 'ID do CONTRATO (contrato_id de buscar_cliente_por_cpf). Opcional se cliente já identificado.',
        },
        fatura_id: {
          type: 'number',
          description:
            'ID da fatura (faturas_vencidas[].id ou faturas_a_vencer[].id). Obrigatório quando não há vencida e o cliente escolheu qual fatura quer.',
        },
        enviar_whatsapp: {
          type: 'boolean',
          description: 'Se true, envia por WhatsApp (padrão: true)',
        },
        celular_whatsapp: {
          type: 'string',
          description:
            'Celular com WhatsApp informado pelo cliente (com DDD). SEMPRE pergunte qual número usar — pode ser diferente do telefone da ligação.',
        },
        resumo_atendimento: {
          type: 'string',
          description:
            'Resumo objetivo do que foi feito na ligação (ex.: identificação, consultas, diagnóstico, ações realizadas)',
        },
        resposta_cliente: {
          type: 'string',
          description:
            'Resposta clara sobre o que o cliente questionou (ex.: motivo da suspensão, orientação técnica, próximos passos)',
        },
      },
      required: ['celular_whatsapp', 'resumo_atendimento', 'resposta_cliente'],
    },
  },
  {
    type: 'function',
    name: 'confirmar_titular_contrato',
    description:
      'Registra se o cliente confirmou ser o titular do contrato após buscar_cliente_por_cpf. Use SOMENTE após perguntar o nome do contrato e ouvir a resposta do cliente.',
    parameters: {
      type: 'object',
      properties: {
        confirmado: {
          type: 'boolean',
          description: 'true se o cliente confirmou que é o titular; false se negou',
        },
      },
      required: ['confirmado'],
    },
  },
  {
    type: 'function',
    name: 'selecionar_contrato',
    description:
      'Seleciona qual contrato atender quando o cliente tem mais de um. Use APÓS confirmar o titular e o cliente informar o ENDEREÇO desejado.',
    parameters: {
      type: 'object',
      properties: {
        contrato_id: {
          type: 'number',
          description: 'ID do contrato (contrato_id da lista contratos_disponiveis retornada por buscar_cliente_por_cpf)',
        },
      },
      required: ['contrato_id'],
    },
  },
  {
    type: 'function',
    name: 'verificar_massiva',
    description:
      'Verifica falha massiva (SGP + Zabbix). Só use APÓS identificar o cliente por CPF e confirmar o titular.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
  {
    type: 'function',
    name: 'consultar_zabbix',
    description:
      'Consulta alertas ativos no Zabbix (CTO off, queda de POP, Queda da Interface, DSE/energia). Use após verificar_massiva se precisar detalhar o incidente de monitoramento.',
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
        cliente_id: {
          type: 'number',
          description: 'ID do CONTRATO (contrato_id de buscar_cliente_por_cpf). Opcional se cliente já identificado.',
        },
      },
      required: [],
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
        cliente_id: {
          type: 'number',
          description: 'ID do CONTRATO (contrato_id de buscar_cliente_por_cpf). Opcional se cliente já identificado.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'abrir_chamado',
    description:
      'Abre ordem de serviço técnico no SGP. Use SOMENTE após esgotar diagnóstico remoto E o cliente confirmar que tentou as orientações (reiniciar roteador/ONU) e não funcionou. NUNCA use no mesmo turno em que orienta uma ação — aguarde a resposta do cliente. Pode enviar protocolo por WhatsApp com resumo do atendimento.',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: {
          type: 'number',
          description: 'ID do CONTRATO (contrato_id de buscar_cliente_por_cpf). Opcional se cliente já identificado.',
        },
        titulo: { type: 'string', description: 'Título breve do problema' },
        descricao: {
          type: 'string',
          description:
            'Descrição detalhada: o que o cliente relatou, diagnóstico realizado, ações tentadas e resultado',
        },
        enviar_whatsapp: {
          type: 'boolean',
          description: 'Se true, envia protocolo e resumo por WhatsApp',
        },
        celular_whatsapp: {
          type: 'string',
          description: 'Celular com WhatsApp informado pelo cliente (com DDD)',
        },
        resumo_atendimento: {
          type: 'string',
          description: 'Resumo do que foi feito na ligação até abrir o chamado',
        },
        resposta_cliente: {
          type: 'string',
          description: 'Resposta ao que o cliente questionou (ex.: situação da internet, o que será feito)',
        },
      },
      required: ['titulo', 'descricao'],
    },
  },
  {
    type: 'function',
    name: 'enviar_resumo_whatsapp',
    description:
      'Envia por WhatsApp o resumo completo do atendimento: o que foi feito, resposta ao cliente, protocolo(s) abertos e fatura/PIX gerados nesta chamada. Use no final do atendimento ou quando o cliente pedir tudo por escrito.',
    parameters: {
      type: 'object',
      properties: {
        celular_whatsapp: {
          type: 'string',
          description: 'Celular com WhatsApp informado pelo cliente (com DDD)',
        },
        resumo_atendimento: {
          type: 'string',
          description: 'Resumo completo do atendimento realizado na ligação',
        },
        resposta_cliente: {
          type: 'string',
          description: 'Resposta clara ao motivo do contato do cliente',
        },
      },
      required: ['celular_whatsapp', 'resumo_atendimento', 'resposta_cliente'],
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
        cliente_id: {
          type: 'number',
          description: 'ID do CONTRATO (contrato_id de buscar_cliente_por_cpf). Opcional se cliente já identificado.',
        },
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
      required: ['descricao'],
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
        cliente_id: {
          type: 'number',
          description: 'ID do CONTRATO (contrato_id de buscar_cliente_por_cpf). Opcional se cliente já identificado.',
        },
      },
      required: [],
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
