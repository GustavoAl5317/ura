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
        celular_confirmado: {
          type: 'boolean',
          description:
            'true SOMENTE após o cliente confirmar o número (sim/certo). Se false ou omitido, o envio é bloqueado até confirmar.',
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
    name: 'consultar_pppoe',
    description:
      'Verifica no RADIUS se o cliente está autenticado na rede agora: login, IP e desde quando. '
      + 'Use em problemas de conexão para separar "não autentica" (ONU/cabo/bloqueio) de '
      + '"autentica mas está lento" (Wi-Fi ou capacidade).',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: { type: 'number', description: 'ID do CONTRATO. Opcional se cliente já identificado.' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'testar_velocidade',
    description:
      'Dispara um teste de velocidade no roteador do cliente via TR-069. Mede o que chega no '
      + 'equipamento, sem depender do celular ou do Wi-Fi dele. Use em reclamação de lentidão, '
      + 'depois de descartar massiva.',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: { type: 'number', description: 'ID do CONTRATO. Opcional se cliente já identificado.' },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'alterar_canal_wifi',
    description:
      'Troca o canal do Wi-Fi. Use quando houver muita interferência de redes vizinhas — '
      + 'sintoma típico é lentidão só no Wi-Fi, com o cabo funcionando bem. '
      + 'Em 2.4 GHz prefira 1, 6 ou 11, que não se sobrepõem.',
    parameters: {
      type: 'object',
      properties: {
        canal: { type: 'number', description: 'Número do canal. Em 2.4 GHz use 1, 6 ou 11.' },
        cliente_id: { type: 'number', description: 'ID do CONTRATO. Opcional se cliente já identificado.' },
      },
      required: ['canal'],
    },
  },
  {
    type: 'function',
    name: 'consultar_agenda_tecnica',
    description:
      'Mostra quantas visitas técnicas já estão agendadas por dia num período. '
      + 'Use ANTES de agendar_visita_tecnica para sugerir ao cliente o dia com menos visitas marcadas.',
    parameters: {
      type: 'object',
      properties: {
        data_inicial: { type: 'string', description: 'Início do período, formato AAAA-MM-DD.' },
        data_final: { type: 'string', description: 'Fim do período, formato AAAA-MM-DD.' },
      },
      required: ['data_inicial', 'data_final'],
    },
  },
  {
    type: 'function',
    name: 'alterar_plano',
    description:
      'Troca o plano do cliente — muda a VELOCIDADE e o VALOR DA MENSALIDADE. '
      + 'Fluxo obrigatório: 1) consultar_planos para pegar o plano_id e o preço; '
      + '2) dizer ao cliente o plano e o novo valor exato; 3) obter o "sim" dele; '
      + '4) só então chamar com confirmado=true. Nunca altere por iniciativa própria.',
    parameters: {
      type: 'object',
      properties: {
        plano_id: { type: 'number', description: 'ID do plano obtido em consultar_planos.' },
        confirmado: {
          type: 'boolean',
          description: 'true somente depois de o cliente confirmar o plano e o valor.',
        },
        cliente_id: { type: 'number', description: 'ID do CONTRATO. Opcional se cliente já identificado.' },
      },
      required: ['plano_id', 'confirmado'],
    },
  },
  {
    type: 'function',
    name: 'consultar_historico_chamados',
    description:
      'Lista os chamados anteriores do cliente e as visitas técnicas já agendadas. '
      + 'Use SEMPRE antes de abrir_chamado ou agendar_visita_tecnica, para não duplicar: '
      + 'se já houver chamado aberto ou visita marcada, informe o protocolo/data em vez de abrir outro.',
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
    name: 'alterar_wifi',
    description:
      'Altera a senha e/ou o nome (SSID) do Wi-Fi do cliente remotamente, nas redes 2.4G e 5G. '
      + 'Use APENAS quando o cliente pedir explicitamente. CONFIRME com ele o valor exato antes de aplicar '
      + 'e avise que todos os aparelhos vão desconectar. A senha precisa ter no mínimo 8 caracteres.',
    parameters: {
      type: 'object',
      properties: {
        nova_senha: {
          type: 'string',
          description: 'Nova senha do Wi-Fi, mínimo 8 caracteres. Omita se o cliente só quer trocar o nome.',
        },
        novo_nome: {
          type: 'string',
          description: 'Novo nome da rede (SSID). Omita se o cliente só quer trocar a senha.',
        },
        cliente_id: {
          type: 'number',
          description: 'ID do CONTRATO. Opcional se cliente já identificado.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'reiniciar_roteador',
    description:
      'Reinicia remotamente o ROTEADOR (Wi-Fi) do cliente via TR-069. Diferente de reiniciar_onu, '
      + 'que reinicia o equipamento de fibra. Use quando a ONU está online e com sinal bom, '
      + 'mas o cliente segue sem navegar ou com lentidão — indica problema no roteador.',
    parameters: {
      type: 'object',
      properties: {
        cliente_id: {
          type: 'number',
          description: 'ID do CONTRATO. Opcional se cliente já identificado.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'consultar_contrato',
    description:
      'Consulta a situação do contrato: status (ativo/suspenso/cancelado) e o motivo, data de cadastro, '
      + 'endereço de instalação e os serviços vinculados — plano, login PPPoE, equipamento, se está conectado '
      + 'e desde quando. Use quando o cliente perguntar sobre o cadastro, o endereço, qual plano tem, '
      + 'por que está suspenso, qual o login de conexão, ou para conferir o estado geral antes de abrir chamado.',
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
        celular_confirmado: {
          type: 'boolean',
          description:
            'true SOMENTE após o cliente confirmar o número (sim/certo). Se false ou omitido, o envio é bloqueado.',
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
        celular_confirmado: {
          type: 'boolean',
          description:
            'true SOMENTE após o cliente confirmar o número (sim/certo). Se false ou omitido, o envio é bloqueado.',
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
        cep: {
          type: 'string',
          description:
            'CEP com exatamente 8 dígitos. NUNCA use para nome de rua numérica (ex.: "Rua 830" não é CEP). Se o cliente disser rua/avenida + número/casa, use logradouro e numero.',
        },
        logradouro: { type: 'string', description: 'Nome da rua/avenida (ex.: "Rua 830")' },
        numero: { type: 'string', description: 'Número do imóvel (ex.: "71")' },
        bairro: {
          type: 'string',
          description: 'Bairro — OBRIGATÓRIO quando informar logradouro (rua + número + bairro)',
        },
        cidade: { type: 'string' },
      },
    },
  },
  {
    type: 'function',
    name: 'registrar_interesse',
    description:
      'Registra interesse do cliente no grupo de vendas via WhatsApp. Para mudanca_endereco: use APÓS CPF, consultar_financeiro e verificar_viabilidade no novo endereço.',
    parameters: {
      type: 'object',
      properties: {
        tipo_interesse: {
          type: 'string',
          enum: ['nova_assinatura', 'mudanca_endereco', 'interesse_cobertura'],
          description: 'Tipo da solicitação. mudanca_endereco = cliente cadastrado quer mudar de endereço.',
        },
        nome: {
          type: 'string',
          description:
            'Nome completo. Para mudanca_endereco com cliente já identificado, pode omitir — usa o cadastro.',
        },
        celular: {
          type: 'string',
          description:
            'Celular com WhatsApp e DDD (11 dígitos). Pergunte: "Pode falar com o DDD?" e confirme dígito a dígito.',
        },
        email: { type: 'string', description: 'E-mail do interessado (opcional, não insistir se não tiver)' },
        endereco: {
          type: 'string',
          description:
            'Endereço consultado. Para mudanca_endereco: o NOVO endereço (onde o cliente quer mudar).',
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
      required: ['endereco'],
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
  {
    type: 'function',
    name: 'ignorar_ruido',
    description: 'Chame esta ferramenta quando a fala captada do cliente for um ruído de fundo, palavras isoladas em inglês (ex: "Thank you", "Bye") ou alucinações em português (ex: "Obrigado por assistir", "Legendas por..."). Isso impede que você responda a alucinações do microfone. NUNCA dê uma resposta em áudio quando usar esta ferramenta.',
    parameters: {
      type: 'object',
      properties: {},
    },
  },
];

