#!/usr/bin/env bash
# Firewall da porta do assistente — roda como ExecStartPre do systemd.
#
# Existe porque o assistente escuta em 0.0.0.0 (o painel e a ponte da URA
# precisam alcançá-lo) e a VM tem IP público: sem isto, qualquer um na internet
# abre o painel. As regras do iptables somem no reboot e a VM não tem
# netfilter-persistent; reaplicar a cada start do serviço garante que o
# assistente nunca sobe exposto.
#
# Mexe SÓ na porta do assistente, numa chain própria (ASSISTENTE). SSH, Docker e
# as outras portas ficam como estão.
#
# Configuração no .env:
#   ASSISTANT_PORT=9030
#   ASSISTANT_FIREWALL_LIBERAR="127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 201.16.193.26"
#     (IPs ou redes CIDR separados por espaço ou vírgula; sem a variável, só as
#      redes internas; "desligado" não aplica regra nenhuma)
#
# Teste manual:  bash scripts/firewall-assistente.sh && iptables -L ASSISTENTE -n

set -euo pipefail

DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV="$DIR/.env"

# Lê uma chave do .env sem executá-lo: o .env tem segredos e sintaxe livre, e
# `source` rodaria qualquer coisa que estivesse lá.
ler_env() {
  [ -f "$ENV" ] || return 0
  # `|| true`: chave ausente é normal, e com pipefail o grep sem match abortaria o script.
  { grep -E "^$1=" "$ENV" || true; } | tail -n1 | cut -d= -f2- | sed -e 's/[[:space:]]*$//' -e 's/^["'\'']//' -e 's/["'\'']$//'
}

PORTA="$(ler_env ASSISTANT_PORT)"; PORTA="${PORTA:-9030}"
# HTTPS do painel (opcional) passa pelo mesmo filtro.
PORTA_HTTPS="$(ler_env ASSISTANT_HTTPS_PORT)"; [ "$PORTA_HTTPS" = "0" ] && PORTA_HTTPS=""
LIBERAR="$(ler_env ASSISTANT_FIREWALL_LIBERAR)"
LIBERAR="${LIBERAR:-127.0.0.0/8 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16}"

if [ "$LIBERAR" = "desligado" ]; then
  echo "firewall-assistente: ASSISTANT_FIREWALL_LIBERAR=desligado — porta $PORTA sem filtro"
  exit 0
fi

if [ -n "$PORTA_HTTPS" ] && ! [[ "$PORTA_HTTPS" =~ ^[0-9]+$ ]]; then
  echo "firewall-assistente: ASSISTANT_HTTPS_PORT inválida: $PORTA_HTTPS" >&2
  exit 1
fi

if ! [[ "$PORTA" =~ ^[0-9]+$ ]]; then
  echo "firewall-assistente: ASSISTANT_PORT inválida: $PORTA" >&2
  exit 1
fi

# Valida TUDO antes de tocar no iptables: um item errado não pode deixar a
# chain pela metade.
FONTES=()
for s in ${LIBERAR//,/ }; do
  if ! [[ "$s" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$ ]]; then
    echo "firewall-assistente: item inválido em ASSISTANT_FIREWALL_LIBERAR: '$s'" >&2
    exit 1
  fi
  FONTES+=("$s")
done

# Monta a chain nova ao lado e só então troca o salto da INPUT. Esvaziar e
# repreencher a chain em uso deixaria a porta aberta durante a troca.
iptables -N ASSISTENTE_NOVO 2>/dev/null || iptables -F ASSISTENTE_NOVO
for s in "${FONTES[@]}"; do
  iptables -A ASSISTENTE_NOVO -s "$s" -j ACCEPT
done
iptables -A ASSISTENTE_NOVO -j DROP

for p in $PORTA $PORTA_HTTPS; do
  iptables -I INPUT 1 -p tcp --dport "$p" -j ASSISTENTE_NOVO
done
# Remove saltos antigos (inclusive de outra porta, se ASSISTANT_PORT mudou).
while iptables -S INPUT | grep -q -- '-j ASSISTENTE$'; do
  regra="$(iptables -S INPUT | grep -- '-j ASSISTENTE$' | head -n1 | sed 's/^-A INPUT //')"
  # shellcheck disable=SC2086
  iptables -D INPUT $regra
done
if iptables -n -L ASSISTENTE >/dev/null 2>&1; then
  iptables -F ASSISTENTE
  iptables -X ASSISTENTE
fi
iptables -E ASSISTENTE_NOVO ASSISTENTE

echo "firewall-assistente: porta(s) $PORTA ${PORTA_HTTPS} liberada(s) só para ${FONTES[*]}"
