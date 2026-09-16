"""Adiciona ao Flow Guard uma chave SÓ DE LEITURA (FLOW_READONLY_API_KEY).

Aborta sem mexer em nada se algum trecho esperado não for encontrado
exatamente uma vez.
"""
import re
import sys
from pathlib import Path

arq = Path(sys.argv[1] if len(sys.argv) > 1 else "auth.py")
s = arq.read_text(encoding="utf-8")
if "FLOW_READONLY_API_KEY" in s:
    print("auth.py já tem a chave só de leitura; nada a fazer")
    sys.exit(0)

trocas = [
    ("from fastapi import Depends, HTTPException, status\n",
     "from fastapi import Depends, HTTPException, Request, status\n"),
    ('COLLECTOR_API_KEY = os.getenv("FLOW_COLLECTOR_API_KEY", "")\n',
     'COLLECTOR_API_KEY = os.getenv("FLOW_COLLECTOR_API_KEY", "")\n'
     '# Chave estática SÓ DE LEITURA (assistente de observabilidade): aceita apenas\n'
     '# GET/HEAD. Não expira, então não pode ter poder de escrita.\n'
     'READONLY_API_KEY = os.getenv("FLOW_READONLY_API_KEY", "")\n'),
    ("def get_current_user(\n    credentials",
     "def get_current_user(\n    request: Request,\n    credentials"),
    ('        return {"username": "collector", "role": "service"}\n',
     '        return {"username": "collector", "role": "service"}\n'
     '\n'
     '    if READONLY_API_KEY and credentials.credentials == READONLY_API_KEY:\n'
     '        if request.method not in ("GET", "HEAD"):\n'
     '            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Chave somente leitura")\n'
     '        return {"username": "assistente", "role": "readonly"}\n'),
]
for antes, depois in trocas:
    n = s.count(antes)
    if n != 1:
        print(f"ABORTADO: trecho encontrado {n} vez(es): {antes[:60]!r}")
        sys.exit(1)
    s = s.replace(antes, depois)
arq.write_text(s, encoding="utf-8")
print("auth.py atualizado")
