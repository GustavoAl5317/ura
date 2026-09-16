#!/bin/bash
# Impede que o disco da flow-vm encha de novo (encheu em 28/07/2026).
# Cron do usuário flow, a cada 10 min.
#  - flows.json: o goflow2 escreve ~7 GB/dia e ninguém lia de volta. Acima de
#    1 GB é esvaziado; o coletor v2 percebe e recomeça do início. Perde-se só o
#    que ainda não tinha sido lido (atraso do coletor, normalmente < 1 MB).
#  - log da API: acima de 100 MB é esvaziado (a API grava com >>, então é seguro).
F=/opt/flow-guard/goflow2/flows/flows.json
L=/home/flow/flow-guard-api.log
tam() { stat -c %s "$1" 2>/dev/null || echo 0; }
if [ "$(tam "$F")" -gt $((1024*1024*1024)) ]; then
  truncate -s 0 "$F" && echo "$(date '+%F %T') flows.json esvaziado" >> /home/flow/flow-guard-manutencao.log
fi
if [ "$(tam "$L")" -gt $((100*1024*1024)) ]; then
  truncate -s 0 "$L"
fi
