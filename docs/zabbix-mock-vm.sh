#!/bin/bash
# Instala cenários de mock Zabbix em /opt/ura-openai-rt/zabbix-mocks/
# Uso: bash docs/zabbix-mock-vm.sh
# Trocar cenário: ZABBIX_MOCK_SCENARIO=link no .env + pm2 restart ura-ai --update-env

set -e
ROOT="${1:-/opt/ura-openai-rt}"
MOCKS="$ROOT/zabbix-mocks"
mkdir -p "$MOCKS"

write() {
  local file="$1"
  shift
  cat > "$MOCKS/$file" << EOF
$@
EOF
  echo "  ok $file"
}

echo "=== Criando zabbix-mocks em $MOCKS ==="

write cto_off.json '{
  "nome": "Queda de Clientes na CTO",
  "host": "CTO 6 R. POMAR CARIOCA - OLT-3 (172.16.22.10)",
  "hostVisivel": "CTO 6 R. POMAR CARIOCA",
  "tipo": "cto_off",
  "desde": "2026-07-01T10:00:00.000Z",
  "resumo": "[MOCK] Queda de clientes na CTO do cliente"
}'

write pppoe_off.json '{
  "nome": "Queda de sessões na CTO CTO 6 R. POMAR CARIOCA",
  "host": "CTO 6 R. POMAR CARIOCA - OLT-3 (172.16.22.10)",
  "hostVisivel": "CTO 6 R. POMAR CARIOCA",
  "tipo": "pppoe_off",
  "desde": "2026-07-01T10:00:00.000Z",
  "resumo": "[MOCK] Queda de sessões PPPoE na CTO do cliente"
}'

write pop_off.json '{
  "nome": "Queda no POP Aquitel - link indisponível",
  "host": "CTO 6 R. POMAR CARIOCA - OLT-3 (172.16.22.10)",
  "hostVisivel": "POP Aquitel",
  "tipo": "pop_off",
  "desde": "2026-07-01T10:00:00.000Z",
  "resumo": "[MOCK] Queda no POP que atende a CTO do cliente"
}'

write fibra.json '{
  "nome": "Queda da Interface uplink OLT-3",
  "host": "CTO 6 R. POMAR CARIOCA - OLT-3 (172.16.22.10)",
  "hostVisivel": "OLT-3",
  "tipo": "fibra",
  "desde": "2026-07-01T10:00:00.000Z",
  "resumo": "[MOCK] Queda de interface/fibra na infraestrutura do cliente"
}'

write link.json '{
  "nome": "Queda do Link fibra CTO 6 R. POMAR CARIOCA",
  "host": "CTO 6 R. POMAR CARIOCA - OLT-3 (172.16.22.10)",
  "hostVisivel": "CTO 6 R. POMAR CARIOCA",
  "tipo": "link",
  "desde": "2026-07-01T10:00:00.000Z",
  "resumo": "[MOCK] Rompimento/queda de link na rede do cliente"
}'

write energia.json '{
  "nome": "DSE sem energia - rack OLT-3",
  "host": "CTO 6 R. POMAR CARIOCA - OLT-3 (172.16.22.10)",
  "hostVisivel": "OLT-3 DSE",
  "tipo": "energia",
  "desde": "2026-07-01T10:00:00.000Z",
  "resumo": "[MOCK] Falta de energia/DSE na infraestrutura (CTO/OLT)"
}'

write energia_cliente.json '{
  "nome": "ONU 48575443AFA284AC - Power desligado",
  "host": "48575443AFA284AC",
  "hostVisivel": "ONU 48575443AFA284AC - CTO 6 R. POMAR CARIOCA",
  "tipo": "energia_cliente",
  "desde": "2026-07-01T10:00:00.000Z",
  "resumo": "[MOCK] Equipamento do cliente sem energia (tomada/desligado)"
}'

write equipamento_cliente.json '{
  "nome": "ONU 48575443AFA284AC - OFFLINE",
  "host": "48575443AFA284AC",
  "hostVisivel": "ONU 48575443AFA284AC - CTO 6 R. POMAR CARIOCA",
  "tipo": "equipamento_cliente",
  "desde": "2026-07-01T10:00:00.000Z",
  "resumo": "[MOCK] ONU do cliente offline no monitoramento"
}'

write poe.json '{
  "nome": "Falha PoE desligado na CTO 6 R. POMAR CARIOCA",
  "host": "CTO 6 R. POMAR CARIOCA - OLT-3 (172.16.22.10)",
  "hostVisivel": "CTO 6 R. POMAR CARIOCA",
  "tipo": "poe",
  "desde": "2026-07-01T10:00:00.000Z",
  "resumo": "[MOCK] Falha de energia PoE na CTO do cliente"
}'

echo ""
echo "=== Ative no .env ==="
echo "ZABBIX_MOCK=1"
echo "ZABBIX_MOCK_SCENARIO=cto_off   # troque pelo cenário"
echo ""
echo "Cenários: cto_off pppoe_off pop_off fibra link energia energia_cliente equipamento_cliente poe"
echo ""
echo "Cliente teste: CPF 61389434303 | CTO 6 R. POMAR CARIOCA | SN 48575443AFA284AC"
