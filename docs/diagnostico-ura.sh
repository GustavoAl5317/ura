#!/bin/bash
# Rode no Issabel: bash docs/diagnostico-ura.sh
echo "=== URA AI — diagnóstico ==="

echo -e "\n1. pm2"
pm2 list | grep ura-ai || echo "ura-ai NÃO está no pm2"

echo -e "\n2. Build (último startup)"
grep -E 'build 20|URA    :' /root/.pm2/logs/ura-ai-out.log | tail -3

echo -e "\n3. URA ligada no painel?"
curl -sf http://127.0.0.1:9020/health 2>/dev/null || echo "ERRO: sidecar 9020 não responde"
curl -s http://127.0.0.1:9020/health 2>/dev/null; echo

echo -e "\n4. Endpoint /ura-enabled (dialplan precisa disso)"
curl -sf -o /dev/null -w "HTTP %{http_code}\n" http://127.0.0.1:9020/ura-enabled 2>/dev/null || echo "ERRO: 404 = dialplan manda tudo pro 8000 sem passar na URA"

echo -e "\n5. Estado persistido (painel)"
cat /opt/ura-openai-rt/data/ura-state.json 2>/dev/null || echo "(sem arquivo — usa URA_ENABLED do .env)"

echo -e "\n6. Portas"
nc -z 127.0.0.1 9019 && echo "9019 AudioSocket: OK" || echo "9019 AudioSocket: FECHADA"
nc -z 127.0.0.1 9020 && echo "9020 Sidecar: OK" || echo "9020 Sidecar: FECHADA"

echo -e "\n7. Dialplan usa ura-enabled?"
grep -n ura-enabled /etc/asterisk/extensions_custom.conf 2>/dev/null || echo "ATENÇÃO: dialplan sem check ura-enabled"

echo -e "\n8. Última chamada (procure TTS ElevenLabs)"
grep -E 'Nova conexão|Chamada iniciada|Pipeline áudio|TTS ElevenLabs|TTS erro|URA desligada' /root/.pm2/logs/ura-ai-out.log | tail -15
