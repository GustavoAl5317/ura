# Atendente de Chat (WhatsApp)

Atendente de texto que **reaproveita 100% das consultas e da lógica de negócio da URA de voz**.
As mesmas ferramentas (CPF, financeiro, 2ª via/PIX, massiva, Zabbix, ONU, chamado, viabilidade,
planos, etc.) rodam num loop de chat com a OpenAI, e as respostas voltam pelo WhatsApp.

## Como funciona

```
Cliente (WhatsApp) ──▶ Evolution API ──webhook──▶ [CHAT_WEBHOOK_PORT]/webhook
                                                        │
                                          ChatSessionStore (1 sessão por número)
                                                        │
                                       loop OpenAI Chat Completions + function calling
                                                        │
                              registerTools() ← MESMOS handlers da URA (src/tools/handlers.ts)
                                                        │
                        SGP · Geosite · Zabbix · WhatsApp (envio) ──▶ resposta no mesmo chat
```

- **Motor:** [`src/chat/session.ts`](../src/chat/session.ts) — sessão por número, histórico e loop agêntico.
- **Ferramentas:** as definições da URA ([`src/tools/definitions.ts`](../src/tools/definitions.ts)) são
  convertidas para o formato da Chat Completions em [`src/chat/definitions.ts`](../src/chat/definitions.ts)
  (exceto `ignorar_ruido`, que só existe por causa de ruído de áudio). Os handlers de negócio
  ([`src/tools/handlers.ts`](../src/tools/handlers.ts)) são registrados **sem alteração** via a
  interface `ToolRegistrar`.
- **Overrides de chat:** [`src/chat/overrides.ts`](../src/chat/overrides.ts) adapta `transferir_para_atendente`
  (avisa um grupo humano em vez de transferir via AMI) e `encerrar_atendimento`, e injeta o número do
  cliente nas ferramentas de envio (o WhatsApp dele é o próprio remetente — não precisa pedir/confirmar).
- **Prompt:** [`src/chat/prompt.ts`](../src/chat/prompt.ts) — mesmos fluxos da voz (técnico, lentidão,
  financeiro, cancelamento, mudança de endereço, vendas), sem regras de áudio (ruído, pronúncia,
  "falar em silêncio", barge-in) e com estilo de chat.
- **Webhook:** [`src/chat/webhook.ts`](../src/chat/webhook.ts) — recebe `messages.upsert`, ignora
  mensagens próprias/grupos/status e responde pelo mesmo número.

## Identificação do cliente

Mantém o fluxo da URA: pede **CPF** e **confirma o titular** antes de qualquer consulta
(financeiro, massiva, ONU). O número do WhatsApp **não** é usado para autenticar.

## Configuração

1. Preencha as variáveis `CHAT_*` no `.env` (veja `.env.example`). O bloco `WHATSAPP_*`
   (Evolution) já existente é reutilizado para **enviar** as respostas.
2. Na Evolution API, cadastre um **webhook** apontando para:
   ```
   http://<host-da-ura>:9022/webhook
   ```
   com o evento **`MESSAGES_UPSERT`** habilitado. Se definir `CHAT_WEBHOOK_TOKEN`, inclua-o
   como `?token=...` na URL ou no header `apikey`/`Authorization`.
3. Suba a URA normalmente (`npm run dev` ou `npm start`). O log deve mostrar
   `Chat WhatsApp escutando webhook na porta 9022`.

## Painel de atendimento humano

Acesse **`http://<host>:9022/`** (mesma porta do webhook).

### Login e usuários

Cada atendente entra com **login e senha própria**. No primeiro boot o sistema cria um
administrador (`CHAT_ADMIN_USER` / `CHAT_ADMIN_PASS`); se a senha não for definida, ela é
sorteada e aparece **uma única vez no log**:

```
systemctl restart ura-chat && journalctl -u ura-chat -n 20 --no-pager | grep -A3 "administrador criado"
```

O administrador usa o menu **Usuários** para adicionar atendentes, trocar senhas, desativar
ou remover contas. Senhas são guardadas com `scrypt` + salt em `data/chat-usuarios.json`
(fora do git); a sessão é um cookie `HttpOnly` de 12 h.

| Perfil | Pode |
|---|---|
| **Administrador** | Tudo, incluindo gerenciar usuários e **assumir uma conversa de outra atendente** |
| **Atendente** | Atender conversas; não vê o menu Usuários nem toma conversa de colega |

### Menu

| Seção | Estado |
|---|---|
| 💬 Atendimento | funcionando |
| 👥 Usuários | funcionando (só administrador) |
| 📋 Auditoria | **em desenvolvimento** |
| 🔎 Consulta SGP | **em desenvolvimento** |
| 📄 Contrato | **em desenvolvimento** |

### Atendimento

Três colunas, no estilo do WhatsApp Web:

| Coluna | O que mostra |
|---|---|
| **Conversas** | Todas as conversas ativas, com etiqueta `IA` / `você` / `transferir` / `encerrada` |
| **Conversa** | A troca de mensagens + **cada consulta que a IA fez**, em linguagem humana ("Consultando o financeiro"). Clique na consulta para ver os parâmetros e o retorno cru |
| **Dados do cliente** | Se é cliente ou não, cadastro, contrato, situação financeira, ONU/sinal e protocolos abertos nesta conversa |

**Fluxo de intervenção:**
1. Enquanto a IA atende, a barra de digitação fica **travada** ("🔒 A Ana está conduzindo").
2. A atendente clica em **Interferir** → a IA pausa (não responde mais nada) e a barra libera.
3. Ela conversa normalmente pelo painel; as mensagens saem pelo mesmo número do WhatsApp.
4. Ao clicar em **Voltar com a IA**, a IA retoma **já sabendo o que a atendente escreveu**
   (as falas dela entram no histórico como falas do assistente) e continua o atendimento.

Enquanto o modo é `humano`, as mensagens do cliente continuam sendo registradas na timeline,
mas a IA não responde — quem responde é a atendente.

**Duas atendentes na mesma conversa:** quem clicar primeiro fica com ela. As outras veem
"Fulana está atendendo" e acompanham sem poder escrever. Só um administrador pode tomar a
conversa ("Assumir mesmo assim") — a troca fica registrada na timeline.

## Observações

- **Faturas/PIX/boleto e protocolos** são entregues na própria conversa (as ferramentas de envio
  usam automaticamente o número do cliente).
- Uma sessão por número, descartada após `CHAT_SESSION_IDLE_MIN` minutos de inatividade ou ao
  encerrar o atendimento.
- Roda no mesmo processo da URA de voz, sem afetá-la. Para rodar só o chat, desative os demais
  serviços ou use `CHAT_ENABLED=0` para desligar apenas o chat.
