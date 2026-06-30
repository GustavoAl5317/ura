# URA desligada — chamada cai e não vai pro ramal

## O que acontece (fluxo real)

```
Cliente liga → DID → ura-ai,s,1
                    │
         porta 9019 aberta? (pm2 rodando)
              │              │
             SIM             NÃO
              │              │
         AudioSocket     atendente → Fila/Ramal
              │
         (Node URA)
```

**Com pm2 parado (URA desligada):** o Asterisk **não pode** entrar no `AudioSocket()` — a conexão TCP falha e a ligação **cai na hora**, a menos que o dialplan teste a porta **antes** com `nc -z 9019`.

**Isso não tem nada a ver com painel.** Só importa se a porta 9019 está aberta.

## Por que cai em vez de ir pro ramal (causas comuns)

| Causa | Sintoma |
|--------|---------|
| Dialplan **sem** `nc -z 9019` antes do AudioSocket | pm2 stop → ligação cai |
| Fila `suporte` **não existe** no Issabel | vai pro atendente mas Queue falha → Hangup |
| Ramal `PJSIP/100` errado / offline | Dial falha → cai |
| `Goto(from-internal,8000,1)` mas extensão 8000 **não existe** | Asterisk não encontra destino → cai |
| `[from-internal]` no custom.conf **conflita** com o Issabel | fila nunca toca |

## Diagnóstico no Issabel (copie e cole)

```bash
# 1. URA está rodando?
pm2 list | grep ura-ai
nc -z 127.0.0.1 9019 && echo "9019 ABERTA" || echo "9019 FECHADA (normal se pm2 stop)"

# 2. Qual fila usar?
asterisk -rx "queue show"

# 3. Extensão 8000 existe?
asterisk -rx "dialplan show 8000@from-internal"

# 4. O que tem no dialplan da URA hoje?
asterisk -rx "dialplan show ura-ai"

# 5. Teste de ligação com log
asterisk -rvvv
# (ligue e veja se aparece "URA indisponivel" ou "AudioSocket" ou "Queue")
```

## Como corrigir

1. Copie `docs/extensions_custom_issabel.conf` para `/etc/asterisk/extensions_custom.conf`
2. Edite no topo do `[ura-ai]`:
   - `FILA_URA=` nome **exato** da fila (`queue show`)
   - `RAMAL_BACKUP=` seu ramal, ex. `PJSIP/2001` ou `SIP/2001`
3. Recarregue:
   ```bash
   asterisk -rx "dialplan reload"
   ```
4. Teste com **pm2 stop ura-ai** e ligue — deve tocar no ramal/fila.

## Teste rápido

```bash
pm2 stop ura-ai
# ligue no número
# deve aparecer no log: "URA indisponivel — fila suporte"
pm2 start ura-ai
```
