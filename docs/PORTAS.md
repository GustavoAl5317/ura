# Portas em uso — Aquitelecom

Registro para evitar colisão. O assistente já nasceu com esse problema: subiu
na 9022 e bateu de frente com o `ura-chat`, que já estava lá.

| Porta | Serviço | Host |
|-------|---------|------|
| 9019 | URA — AudioSocket (Asterisk) | VM da URA |
| 9020 | URA — sidecar HTTP (registro de caller ID) | VM da URA |
| 9021 | URA — painel admin | VM da URA |
| 9022 | **ura-chat** (`dist/chat-only.js`) | 005-MANAGER |
| 9030 | **Assistente de Observabilidade** (`ASSISTANT_PORT`) | 005-MANAGER |
| 8080 | Evolution API (Docker Swarm, publish mode host) | 005-MANAGER |

## Exposição à internet

A 9030 foi encontrada **alcançável de fora** (testado de rede externa em
14/09/2026): o assistente escutava em `0.0.0.0`, que inclui o IP público
`181.191.160.18`. As rotas `/api/*` e `/webhook` exigem chave e respondiam 401,
mas `/health` devolvia sem autenticação o tamanho da base de clientes e o nome
da instância interna. O `/health` foi enxugado; o detalhe foi para `/api/health`.

O único cliente legítimo é o Evolution local, que chega pela bridge do Docker.
Duas formas de fechar, da mais simples para a mais robusta:

```bash
# 1. Escutar só na bridge do Docker (no .env do assistente)
ASSISTANT_HOST=172.17.0.1

# 2. Bloquear no firewall, liberando só loopback e redes privadas
iptables -A INPUT -p tcp --dport 9030 -s 127.0.0.1 -j ACCEPT
iptables -A INPUT -p tcp --dport 9030 -s 172.16.0.0/12 -j ACCEPT
iptables -A INPUT -p tcp --dport 9030 -s 10.0.0.0/8 -j ACCEPT
iptables -A INPUT -p tcp --dport 9030 -j DROP
```

Vale conferir as outras portas desta tabela com o mesmo teste externo.

## Antes de subir qualquer serviço novo

```bash
ss -lnt | grep ":<porta> "
```

Sem saída = livre. O assistente aborta com mensagem clara se a porta estiver
ocupada (não fica vivo sem servir, que era o comportamento antigo).

## Evolution: existem DOIS

- **Local** — `127.0.0.1:8080` nesta VM, em Docker Swarm. É o que o assistente usa.
- **Remoto** — `10.169.0.20:8080` (v2.3.7), outro servidor, chave própria. É o que a URA usa.

A chave global do local está no ambiente do container, e **diverge** do que está
no `/opt/evolution/evolution-stack.yml`. Vale a do container: um `docker stack
deploy` com esse arquivo trocaria a chave e quebraria todas as integrações de uma vez.

```bash
docker exec $(docker ps -qf name=evolution_evolution | head -1) env | grep AUTHENTICATION_API_KEY
```
