#!/bin/bash
# Rode no Issabel: bash discover-attendant.sh

echo "========== FILAS =========="
asterisk -rx "queue show" 2>/dev/null
grep -h "^\[" /etc/asterisk/queues*.conf 2>/dev/null | grep -v general

echo ""
echo "========== RAMAIS PJSIP =========="
asterisk -rx "pjsip show endpoints" 2>/dev/null | grep -E "^ Endpoint:|Contact:|Avail" | head -40

echo ""
echo "========== RAMAIS SIP (legado) =========="
asterisk -rx "sip show peers" 2>/dev/null | head -25

echo ""
echo "========== GRUPOS DE TOQUE =========="
grep -r "grp\|ring-group\|RingGroup" /etc/asterisk/extensions*.conf 2>/dev/null | head -15

echo ""
echo "========== EXTENSAO 8000 HOJE =========="
asterisk -rx "dialplan show 8000@from-internal" 2>/dev/null

echo ""
echo "========== URA PORTAS =========="
nc -z 127.0.0.1 9019 && echo "9019 AudioSocket: ABERTA" || echo "9019 AudioSocket: FECHADA"
nc -z 127.0.0.1 9020 && echo "9020 Sidecar: ABERTA" || echo "9020 Sidecar: FECHADA"
curl -sf --max-time 2 http://127.0.0.1:9020/health && echo "" || echo "9020 /health: indisponivel"
