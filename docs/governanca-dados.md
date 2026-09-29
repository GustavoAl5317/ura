# Governança de dados — assistente de observabilidade

Documento operacional: o que o assistente guarda, por quanto tempo, quem
acessa e como isso é verificado. Escrito em 29/09/2026, junto com o bloco B9.

O painel mostra estas mesmas informações em **Administração → Dados e saúde**,
lidas do próprio sistema. Se este documento divergir do painel, o painel está
certo: ele não é uma cópia, é a fonte.

## 1. O que é guardado

| Dado | Onde | Por que existe |
|---|---|---|
| Pergunta e resposta do assistente | `consulta` | Auditar o que foi respondido a quem. |
| Evidência das respostas | `evidencia` | Provar de onde saiu cada afirmação. É o que mais concentra dado pessoal. |
| Mensagens do chat e do WhatsApp | `conversa`, `mensagem` | Continuidade da conversa e prova do que foi dito. |
| Alertas | `alerta`, `alerta_envio` | Fato operacional e comprovante de entrega. |
| Incidentes | `incidente`, `incidente_evento`, `pos_incidente` | Dono, linha do tempo, causa raiz e métrica. |
| Chamadas da URA | `chamada_ura` | Telefone de quem ligou, intenção e desfecho. |
| Auditoria de alterações | `auditoria` | Quem mudou o quê, quando, com valor anterior. |
| Espelho do SGP | `sgp_*` | Busca por nome, login, SN e CTO. Sem nenhum campo de senha. |

O espelho do SGP **descarta senha PPPoE, senha de wi-fi e senha SIP** na
sincronização, de propósito. Elas vêm na resposta da API e não são gravadas.

## 2. Prazos de retenção

Padrões de fábrica, editáveis em **Comportamento → Retenção de dados**:

| Tipo | Prazo padrão | Racional |
|---|---|---|
| Evidências | 90 dias | Maior concentração de dado pessoal, menor valor histórico. |
| Perguntas respondidas | 180 dias | Auditoria de uso do assistente. |
| Conversas | 180 dias | Mesma lógica das perguntas. |
| Alertas | 365 dias | Base de métrica de curto prazo. |
| Chamadas da URA | 365 dias | Contém telefone. |
| Incidentes encerrados | 730 dias | Recorrência e métrica de ano a ano. |
| Auditoria | 1825 dias | É a última coisa a se apagar: responde "quem fez". |

Regras que o sistema aplica sozinho:

- **Incidente aberto nunca é apagado**, por mais velho que seja.
- **Alerta ligado a incidente ainda guardado não é apagado**: ele é a prova do
  que aconteceu.
- Apagar um incidente apaga junto a linha do tempo, os vínculos com alertas e
  o pós-incidente dele.
- Prazo `0` significa guardar para sempre, e aparece assim no painel.

A limpeza roda no monitor `governanca` e pode ser disparada à mão no painel.
Toda limpeza manual fica na auditoria.

## 3. Quem acessa o quê

| Quem | Pode | Não pode |
|---|---|---|
| Administrador do painel | Tudo: configuração, usuários, regras, prompts, auditoria e todas as fontes. | Ler a senha de alguém (só trocar) ou rever a chave de um bot depois de criada. |
| Operador | Perguntar, assumir incidente, mudar estado, comentar, ver alertas e chamadas. | Configuração, usuários, regras, bots e webhooks. |
| Leitura | Ver painel, incidentes, alertas e histórico. | Perguntar à IA, assumir incidente, alterar qualquer coisa. |
| Técnico cadastrado (WhatsApp) | Perguntar pelas fontes liberadas para ele e para a equipe, e assumir incidente. | Passar do teto de fontes da equipe. |
| Número não cadastrado (modo "rede") | Perguntar sobre a rede: incidentes, links, tráfego. | SGP, URA e atendimento. Esse limite é do código, não da configuração. |
| Bot de sistema | Publicar evento com a chave dele. | Ler qualquer coisa, consultar fonte, usar o painel. |

Dois pontos que valem registro explícito:

1. **O teto público é de código.** Mesmo com a configuração aberta, um número
   não cadastrado não alcança cadastro de cliente, URA nem atendimento
   (`FONTES_PUBLICAS` em `config-dinamica.ts`).
2. **A permissão da pessoa vale para a IA.** A ferramenta consulta a fonte
   passando pelo mesmo controle, então "pedir de outro jeito" não contorna
   nada.

## 4. Segurança de credenciais

- Senha de painel: scrypt com sal por usuário, comparação em tempo constante.
- Chave de bot: guardada como SHA-256, mostrada uma única vez na criação.
- Webhook de saída: assinatura HMAC-SHA256 no corpo, segredo mostrado uma vez.
- Bloqueio por tentativa: 5 erros de senha bloqueiam login e IP por 10 minutos.
- Trocar a senha de um usuário revoga as sessões dele.

## 5. Backup e restauração

- Cópia diária do banco no horário configurado, em `data/backup/`.
- **Toda cópia é aberta e conferida logo depois de gerada**: `integrity_check`,
  contagem de tabelas e contagem de incidentes. Cópia que não passa vira alerta
  crítico.
- São mantidas as N cópias mais recentes (padrão 7); as demais são apagadas.
- Restauração: parar o serviço, substituir `data/assistant.db` pela cópia
  escolhida (apagando `-wal` e `-shm` ao lado), subir o serviço.
- No painel, "Conferir" abre qualquer cópia existente e repete a checagem sem
  restaurar nada.

## 6. Saúde da plataforma

O monitor `governanca` examina, a cada ciclo: integridade do banco, monitores
ativos e suas falhas, idade do último backup, painéis conectados e **silêncio
anormal** — tempo sem nenhum evento com monitor ligado. Silêncio prolongado
costuma ser coleta parada, não rede impecável, e é a única falha que nenhum
alerta comum denuncia.

## 7. Pendências conhecidas

- Chave global do Evolution exposta em conversa precisa ser rotacionada; o
  `interatell01` depende dela.
- O gerenciador do Evolution em `181.191.160.37:8080` está publicamente
  acessível e deveria ficar restrito por firewall.
