# Contexto do projeto — leia antes de responder qualquer coisa

> Documento de handoff. Descreve **quem é o usuário, o que existe, onde está e o que falta**.
> Atualizado em 2026-08-12, no commit `8868e84`.

---

## 1. Quem é quem

- **Eu (usuário):** Gustavo — freelancer/terceirizado. Escrevo o código, faço deploy e
  configuro a Meta. Não sou funcionário da Aquitelecom.
- **Cliente:** **Aquitelecom** (Aqui Telecomunicacoes LTDA), provedor de internet em
  Fortaleza/CE. CNPJ 13.783.789/0001-46 · Rua 832, 25 · CEP 60532-260.
- **Lucas:** contato técnico do lado da Aquitelecom. Cuida do painel da Meta, do SGP e das
  credenciais. Quando eu digo "o Lucas configurou", significa que ele mexeu no Business
  Manager — e vale conferir, porque já aconteceu de estar incompleto.
- **Produto:** atendente de IA no WhatsApp para o ISP. Faz suporte técnico, financeiro e
  vendas, com painel web para atendimento humano assumir a conversa.

**Fale comigo em português do Brasil.** Sou direto e escrevo rápido, com muito typo — se a
mensagem estiver truncada ou com erro de digitação, interprete pelo contexto em vez de
perguntar o que eu quis dizer. Prefiro que você **execute** a que você me apresente opções.

---

## 2. Repositório

| Item | Valor |
|---|---|
| Repo local | `C:\Users\GustavoAlvesSantana\Documents\ura` |
| Worktree ativo | `.claude\worktrees\gifted-kirch-5d6563` |
| Branch | `claude/whatsapp-chat-attendant-b7d011` |
| Branch principal | `main` |
| Runtime | Node 22 (o chat usa `node:sqlite`, que exige ≥ 22.5) |
| Build | `npm run build` (tsc) → `dist/` |
| Entrada do chat | `dist/chat-only.js` |

O projeto nasceu como **URA de voz** (Asterisk + AudioSocket + OpenAI Realtime) e o chat de
WhatsApp foi construído **reaproveitando as mesmas ferramentas de negócio**. Por isso existe
muito arquivo de voz que não tem nada a ver com o chat. Há também lixo na raiz
(`fix_*.js`, `test-*.js`, `patch-*.py`, `handlers_old.ts`) — **ignore, é histórico**.

### Mapa dos arquivos que importam

```
src/chat/
  webhook.ts        Servidor HTTP (porta 9022): webhook Evolution, /cloud/webhook,
                    painel, /politica-de-privacidade. Body acumulado em Buffer —
                    concatenar como string quebra o HMAC da Meta.
  cloud-webhook.ts  Parser do payload da Meta Cloud API.
  session.ts        Motor: 1 sessão por número, loop agêntico, persona, áudio,
                    inatividade (ping 10 min → encerra com protocolo).
  prompt.ts         Prompt do sistema. É AQUI que quase todo bug de comportamento
                    se resolve, não no código.
  voz.ts            TTS. Só responde em áudio se o cliente mandou áudio.
  panel-api.ts      API do painel: listar/abrir conversa, intervir, retomar,
                    enviar texto e arquivo (16 MB).
  repo.ts / db.ts   SQLite (node:sqlite, WAL) em data/atendimento.db.
  auth.ts           Login do painel (scrypt + salt, cookie 12h).
  definitions.ts    Converte as tools da URA para o formato Chat Completions.
  overrides.ts      Adapta transferir_para_atendente / encerrar_atendimento p/ chat.

src/tools/
  definitions.ts    Schema das 29 ferramentas.
  handlers.ts       Implementação (2.4k linhas). Compartilhado com a URA de voz.

src/integrations/
  sgp.ts            ERP SGP (805 linhas). Cliente, contrato, financeiro, ONU,
                    RADIUS, CPE/TR-069, ordens de serviço, acordos.
  geosite.ts        Viabilidade/cobertura.
  zabbix.ts         Monitoramento (massiva, POP, CTO).
  whatsapp.ts       Evolution API (envio, grupos).
  whatsapp-cloud.ts Meta Cloud API (envio, mídia, upload).

panel/
  index.html        Painel de conversas.
  chat.html         Tela de conversa (com botão 📎 de anexo).
  politica-privacidade.html   LGPD. E-mail do DPO ainda está [PREENCHER].

scripts/
  testar-sgp.js             Bateria contra o SGP real.
  testar-cloud-webhook.js   Simula um webhook da Meta contra produção.
```

---

## 3. Infra de produção

```
Cliente no WhatsApp
   │
   ├─ Meta WhatsApp Cloud API  ─────┐   (canal OFICIAL, +55 85 3221-1777)
   └─ Evolution API (self-host) ────┤   (legado; instâncias de produção CAÍDAS)
                                    ▼
                    Cloudflare Tunnel → Caddy → :9022
                                    ▼
                    ura-chat.service  (systemd, /opt/ura-chat)
                                    ▼
        ┌───────────┬──────────┬──────────┬───────────┐
     SGP ERP    GeoSite     Zabbix     OpenAI    SQLite local
```

| Componente | Onde |
|---|---|
| Diretório de deploy | `/opt/ura-chat` |
| Serviço | `systemd` → `ura-chat.service` |
| Config | `/opt/ura-chat/.env` (**não** versionado) |
| Banco | `/opt/ura-chat/data/atendimento.db` (SQLite, modo WAL) |
| Porta interna | `9022` (webhook + painel + API, tudo junto) |
| Domínio público | `https://chatbot.aquitelecom.com` |
| Proxy | **Caddy** (não é nginx) + **Cloudflare Tunnel** |
| Node do serviço | `/opt/node22/bin/node dist/chat-only.js` |

> **Consequência do Cloudflare Tunnel:** todo request chega com IP do túnel, então
> **allowlist por IP não funciona**. A proteção do webhook é o `X-Hub-Signature-256`.

### Rotas expostas

| Rota | Para quê |
|---|---|
| `GET /cloud/webhook` | Verificação da Meta (`hub.challenge`) |
| `POST /cloud/webhook` | Mensagens da Meta (valida HMAC) |
| `POST /webhook` | Evolution (`messages.upsert`) |
| `GET /` | Painel (autenticado) |
| `GET /politica-de-privacidade` | Público — exigido pela Meta |

### Comandos de rotina no servidor

```bash
systemctl status ura-chat
```
```bash
journalctl -u ura-chat -n 200 --no-pager
```
```bash
cd /opt/ura-chat && git pull && npm run build && systemctl restart ura-chat
```

> **Atenção:** deploy derruba requisições em andamento. E `VACUUM` no SQLite em modo WAL
> já deixou o serviço parado e o site em **502** — para limpar o banco use
> `PRAGMA wal_checkpoint(TRUNCATE)` e rode os comandos **separados**, nunca encadeados com `&&`.

---

## 4. Integrações — estado real

### Meta WhatsApp Cloud API ✅ funcionando
- Número **+55 85 3221-1777** migrado, verificado e registrado.
  `status: CONNECTED`, `platform_type: CLOUD_API`.
- Webhook e `subscribed_apps` foram registrados **via Graph API**, não pelo painel.
- App **publicado**.
- Graph API v21.0. Token = System User permanente com `whatsapp_business_messaging` +
  `whatsapp_business_management`.
- Env: `CLOUD_ENABLED`, `CLOUD_API_TOKEN`, `CLOUD_VERIFY_TOKEN`, `CLOUD_APP_SECRET`,
  `CLOUD_GRAPH_VERSION`, `CLOUD_ALLOWED_PHONE_IDS`.
- ⚠️ **Não há forma de pagamento cadastrada.** Só impede mensagem iniciada pela empresa
  (template). Responder a cliente que escreveu primeiro funciona normalmente.

### Evolution API ⚠️ instâncias de produção caídas
- `AQUI-1777` e `AQUI-3377` **desconectadas**. Só `testeWPP` (8730-9201) está conectada.
- **Isso importa:** o aviso de lead de vendas para o grupo interno
  (`WHATSAPP_SALES_GROUP_ID`) sai pelo Evolution. Com a instância morta, **leads de
  contratação podem estar se perdendo**. É a pendência mais cara em aberto.

### SGP (ERP) ✅
- `https://sys.aquitelecom.com` · env `SGP_BASE_URL` / `SGP_APP` / `SGP_TOKEN`.
- 239 endpoints mapeados a partir do Postman público.
- Famílias: `/api/ura/*`, `/api/cpemanager/*` (TR-069/ACS), `/ws/radius/*`, `/api/os/*`,
  `/api/suporte/*`.
- **Armadilhas já descobertas — não repita:**
  - `/api/ura/clientes/` devolve o nº do contrato em **`id`**; outros endpoints usam
    **`contrato`**. Sem normalizar, `contratoId` sai `undefined`.
  - Protocolo de chamado é **`numero`**, não `protocolo`.
  - Chamado encerrado é **`status_id` 0/1**, não `data_finalizacao`.
  - O objeto ONU **nunca** traz `conexao` neste SGP → online/offline vem do RADIUS
    (`/ws/radius/radacct/list/all/`, timeout 12s).
  - Respostas às vezes vêm em `{results|result|data: [...]}` → use o helper `lista<T>()`.
  - **Nem todo contrato tem CPE Manager.** Sem ele, não dá reiniciar roteador nem mexer no Wi-Fi.

### GeoSite (cobertura) ✅ mas foi tarde
- `https://telecom.digicade.com.br/geosite-telecom-api`, usuário `suporteAPI`.
- Ficou **muito tempo respondendo "sem cobertura" para tudo** porque o `.env` só tinha
  `GEOSITE_ENABLED=1`, sem URL nem credencial. Hoje qualquer erro retorna
  `{ temCobertura: false, erro: true }` e a IA diz que **não conseguiu consultar**, em vez
  de afirmar que não há cobertura.
- ⚠️ Leads recusados antes disso deveriam ser recuperados.
- **O cliente não pode ver dados de planta** (CTO, portas, distância). Ficou fora do output.

### Zabbix ✅ · OpenAI ✅
- Zabbix em `https://zabbix.aquitelecom.com`, com mocks em `zabbix-mocks/` para teste.
- OpenAI: `CHAT_MODEL` no chat; TTS em `CHAT_TTS_MODEL`.
  **Cuidado:** o allowlist do **projeto** é diferente do da **organização** — já perdi tempo
  com modelo liberado na org e ausente no projeto.

---

## 5. As 29 ferramentas

```
buscar_cliente_por_cpf · confirmar_titular_contrato · selecionar_contrato · consultar_contrato
consultar_financeiro · gerar_segunda_via · consultar_acordo · desbloqueio_confianca
consultar_onu · reiniciar_onu · consultar_pppoe · testar_velocidade · consultar_zabbix
verificar_massiva · reiniciar_roteador · alterar_wifi · alterar_canal_wifi
abrir_chamado · consultar_historico_chamados · agendar_visita_tecnica · consultar_agenda_tecnica
verificar_viabilidade · consultar_planos · registrar_interesse · alterar_plano
enviar_resumo_whatsapp · transferir_para_atendente · encerrar_atendimento · ignorar_ruido
```

`ignorar_ruido` só existe para a URA de voz e é excluída no chat.

---

## 6. Regras de negócio já implementadas

- **Personas por área:** Ana = vendas · Alex = suporte · Bruna = financeiro.
  A voz do TTS segue o gênero da persona.
- **Áudio:** a IA só responde em áudio **se o cliente mandou áudio**. Acima de 700
  caracteres cai para texto. Formato OGG/Opus (nativo do WhatsApp, sem ffmpeg).
- **Inatividade:** 10 min sem resposta → cutuca; continuou calado → encerra e manda protocolo.
  ⚠️ A conversa **não pode sumir do painel** ao encerrar — isso já foi bug e eu reclamei.
- **Suporte é conversa, não lote.** A IA deve conduzir passo a passo até resolver, e não
  disparar todas as consultas de uma vez e abrir chamado. Regra no `prompt.ts`.
- **Segundo CPF:** se o cliente manda outro CPF, a IA pergunta se ele quer falar de outro
  cadastro antes de trocar (`confirmar_troca=true`).
- **Muitos contratos:** cliente com 14 contratos travava no limite de rounds. Hoje
  `selecionar_contrato` aceita **endereço**, e o número da casa **filtra** em vez de pontuar.
- **Chamado duplicado:** bloqueado — retorna `ja_existe_chamado_aberto`.
- **Nome do cliente:** `primeiroNomeSeguro()` descarta nomes com dígito ou termos de planta
  (FTTX, GPON, CTO...). Evita "Olá, FTTX!".
- **Vendas/adesão:** a IA **não fecha contrato**. Faz `verificar_viabilidade` →
  `consultar_planos` → `registrar_interesse` (`nova_assinatura`), e o lead vai para o grupo
  comercial. Sem cobertura, registra `interesse_cobertura`.
- **Planos oficiais:** 400M R$ 79,90 · 500M R$ 89,90 · 700M R$ 99,90 · 1G R$ 119,90
  (IDs SGP 79/81/82/83). O SGP devolve ~76 planos, quase tudo lixo — use só esses 4.

---

## 7. O que falta

**Bloqueia go-live:**
1. **Rotacionar credenciais.** App Secret, token do System User e PIN foram colados em
   chat. Eu já disse que sei e que na hora certa troco — não me alerte de novo, só lembre
   antes de subir de vez.
2. `SGP_TOKEN` está com valor real commitado no `.env.example`.
3. **Grupo de vendas:** confirmar se `WHATSAPP_SALES_GROUP_ID` ainda entrega. Se o Evolution
   estiver morto, migrar o aviso para a Cloud API ou reconectar uma instância só para alertas.

**Pendências normais:**
4. E-mail do DPO na política de privacidade (`[PREENCHER]`) e revisão pelo Lucas.
5. Confirmar que o modelo de TTS está liberado **no projeto** OpenAI, não só na org.
6. Testar `alterar_wifi` / `reiniciar_roteador` num contrato **que tenha** CPE Manager.
7. `alterar_plano` e `desbloqueio_confianca` **nunca foram testados** e mexem em dinheiro.
   Minha recomendação foi deixar `alterar_plano` desligado até a empresa definir regra.
8. Criação de acordo (só a consulta existe) — depende de centro de custo, portador, número
   máximo de parcelas e política de desconto, que a empresa ainda não passou.
9. Forma de pagamento na Meta, se um dia quisermos notificação proativa (exige template aprovado).

**Fora de alcance por enquanto:** Downdetector (não tem API pública) e "Flow"
(o escopo cita, mas nunca foi definido o que é).

---

## 8. Como eu trabalho — leia isto

- **Execute, não pergunte.** Quando eu digo "faça", é para fazer inteiro, incluindo commit.
- **Bug real vale mais que teoria.** Quase todo defeito veio de conversa de produção que eu
  colei aqui. Se eu colar um transcript, o pedido é: ache a causa e corrija.
- **A causa costuma estar no `prompt.ts`**, não na lógica. Já aconteceu de o texto de
  interpretação de uma tool induzir a IA a abrir chamado cedo demais.
- **Nunca afirme estado que você não verificou.** O caso mais grave foi a IA dizer que a
  conexão estava boa com a ONU offline. Quando não dá para saber, o retorno é `null` e a IA
  diz que não conseguiu consultar.
- Commits em português, no formato `tipo(escopo): descrição`.
- Comentários no código em português, explicando **por que**, não o que.
- Se eu mandar um print, leia o print — não me peça para descrever.
