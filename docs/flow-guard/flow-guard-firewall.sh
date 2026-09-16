#!/bin/bash
# Firewall da Flow Guard API (porta 8000) — roda como ExecStartPre do serviço.
# A API passa a escutar em 0.0.0.0 para a 005-MANAGER (assistente) consultar;
# só ela, a própria máquina e as redes do Docker entram. Mesma técnica do
# firewall do assistente: monta a chain nova ao lado e troca o salto, para a
# porta nunca ficar aberta durante a troca.
set -euo pipefail
PORTA=8000
LIBERAR="127.0.0.0/8 172.16.0.0/12 181.191.160.18"

iptables -N FLOWGUARD_NOVO 2>/dev/null || iptables -F FLOWGUARD_NOVO
for s in $LIBERAR; do iptables -A FLOWGUARD_NOVO -s "$s" -j ACCEPT; done
iptables -A FLOWGUARD_NOVO -j DROP
iptables -I INPUT 1 -p tcp --dport "$PORTA" -j FLOWGUARD_NOVO
while iptables -S INPUT | grep -q -- '-j FLOWGUARD$'; do
  regra="$(iptables -S INPUT | grep -- '-j FLOWGUARD$' | head -n1 | sed 's/^-A INPUT //')"
  # shellcheck disable=SC2086
  iptables -D INPUT $regra
done
if iptables -n -L FLOWGUARD >/dev/null 2>&1; then
  iptables -F FLOWGUARD
  iptables -X FLOWGUARD
fi
iptables -E FLOWGUARD_NOVO FLOWGUARD
echo "flow-guard-firewall: porta $PORTA liberada só para $LIBERAR"
