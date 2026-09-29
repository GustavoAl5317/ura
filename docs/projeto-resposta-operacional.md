# Resposta Operacional — plano por blocos

Projeto único, formado pelo que restou do Projeto 3 (sem o chat interno) somado
ao Projeto 4 inteiro. Decisão de escopo de 28/09/2026, com o Lucas: **não
haverá chat entre colaboradores** (conversa individual, grupos, canais,
threads, presença, chamada de voz entre pessoas). O canal do time continua
sendo grupo de WhatsApp, mais o painel e, depois, push no navegador.

Base já em produção (Projetos 1 e 2): assistente por texto e áudio, consultas a
SGP, Zabbix, NetFlow, QuestDB, URA e atendimento, veredito com evidência,
monitores, alertas por pessoa e por grupo, painel e auditoria.

Cada bloco entrega algo usável, com teste automático e deploy próprio.
Tamanho: P pequeno, M médio, G grande.

## B1 — Acesso e identidade (P)

Login por pessoa no lugar da chave compartilhada.

- Usuário com login, nome, senha (scrypt), papel `admin`, `operador` ou `leitura`.
- Sessão com IP, dispositivo, último acesso; revogação por sessão e por usuário.
- Bloqueio temporário após 5 tentativas erradas.
- Auditoria de login, falha de login e logout.
- A permissão da pessoa vale também para a IA (fontes por usuário e por equipe).
- A chave `ADMIN_API_KEY` passa a valer só para integração entre máquinas.

Teste: senha errada bloqueia; usuário desativado perde a sessão no clique
seguinte; último administrador ativo não pode ser rebaixado.

## B2 — Bots e webhooks (P)

- Bot por sistema (Zabbix, SGP, Central Técnica), cada um com chave própria.
- `POST /api/bots/<slug>/evento` cria alerta com o nome do bot, visualmente
  diferente de mensagem de gente.
- Webhook de saída por evento, com assinatura e retentativa.

Teste: chave errada é recusada; evento repetido não vira alerta novo.

## B3 — Incidente (G)

Coração do projeto.

- Três camadas: evento, alerta e incidente. Alerta vira incidente por regra.
- Incidente pai com eventos filhos, correlacionados por equipamento, PON, OLT e
  janela de tempo.
- Estados: detectado, aberto, notificado, reconhecido, em investigação, em
  atendimento, monitorando normalização, normalizado, encerrado. Mais
  suprimido, manutenção, falso positivo e cancelado.
- Dono único, com assumir, transferir, pedir apoio e escalar à mão.
- Timeline completa, hora a hora.
- Normalização com espera de estabilidade e reabertura automática se cair de novo.
- Painel de incidentes: abertos, sem reconhecimento, críticos, em atendimento.
- Assumir pelo painel e por mensagem no WhatsApp (`assumir 458`).
- Ferramenta nova da IA: incidentes abertos, sem dono, quem está atendendo.

## B4 — Equipes e plantão (M)

- Equipe com supervisor, substituto, membros, região, tipo de evento e severidade.
- Escala fixa e rotativa, folga, férias, ausência, troca e plantão extraordinário.
- Quem está de plantão agora e no próximo turno.
- Cadeia de fallback: plantonista, substituto, supervisor, segundo nível, gerência.
- Painel de plantão.
- Ferramenta da IA: quem está de plantão.

## B5 — Roteamento, SLA e escalonamento (M)

- Roteamento por evento, severidade, equipamento, região, clientes afetados e horário.
- SLA separado para reconhecimento, início de atendimento e resolução.
- Escalonamento por tempo sem reconhecimento, degrau a degrau.
- Canal por severidade.
- Estados de entrega distintos: enviado, entregue, visualizado, reconhecido.

Teste: sem reconhecimento em 5 minutos sobe para o supervisor; alerta crítico
nunca fica sem destino válido.

## B6 — Severidade dinâmica, regras e manutenção (G)

- Seis níveis de severidade, com mudança automática conforme o impacto cresce,
  e registro de cada mudança.
- Motor de regras editável no painel: quando, e, por tempo, então.
- Cooldown, debounce, throttling e supressão.
- Janela de manutenção por equipamento, OLT, PON, POP e região, com efeito
  configurável (sem notificar, severidade menor, suprimir ou manter).

Teste: 8 clientes vira crítico e 34 vira maior; dentro da janela não notifica.

## B7 — Canais extras (M)

- Push web no navegador, com preferência por tipo e horário de silêncio.
- Alerta falado para severidade alta, com silenciar sem reconhecer.
- Contingência entre canais: WhatsApp fora usa push e painel, e o contrário.

## B8 — Histórico, métrica e pós-incidente (M)

- Busca por equipamento, PON, CTO, região, equipe, categoria e período.
- Recorrência: PON e equipamento que mais quebram.
- MTTD, MTTA, MTTR, violação de SLA, taxa de reconhecimento, taxa de reabertura
  e falso positivo.
- Registro de pós-incidente com causa raiz, ações e responsáveis.
- Ferramenta da IA: incidentes desta PON nos últimos 30 dias.

## B9 — Governança e operação (P)

- Retenção por tipo de dado: consulta, evidência, alerta, incidente, chamada e auditoria.
- Regra escrita de quem acessa o quê, com base na LGPD.
- Saúde da própria plataforma, inclusive silêncio anormal de eventos.
- Backup e restauração testados.

## Ordem

1. B1, B2, B3, B4, B5, nesta ordem.
2. B6 e B7 em paralelo.
3. B8 e B9 fecham.

B3 e B6 são os grandes. B1, B2 e B9 são pequenos.
