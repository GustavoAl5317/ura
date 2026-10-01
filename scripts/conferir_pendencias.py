#!/usr/bin/env python3
"""Confere, na 005-MANAGER, o que ficou pendente da entrega.

  [4] faz o primeiro backup conferido e mostra quem recebe alerta e as equipes
  [5] faz as tres perguntas de leigo na MESMA conversa (vocabulario e "e agora?")
  [6] lista as CTOs que pararam de ser coletadas

Uso, de dentro de /opt/ura-assistente:
    python3 scripts/conferir_pendencias.py

Nao imprime chave nenhuma. As perguntas do item 5 passam pelo mesmo agente do
WhatsApp, mas pelo canal do painel: ninguem recebe mensagem no celular.
"""

import json
import os
import re
import urllib.parse
import urllib.request
from datetime import datetime, timezone

BASE = 'http://127.0.0.1:9030'


def ler_env(nome):
    try:
        with open('.env', encoding='utf-8') as f:
            for linha in f:
                m = re.match(r'^%s=(.*)$' % re.escape(nome), linha.strip())
                if m:
                    return m.group(1).strip().strip('"')
    except FileNotFoundError:
        pass
    return ''


CHAVE = ler_env('ADMIN_API_KEY')


def api(metodo, caminho, corpo=None, timeout=120):
    dados = None if corpo is None else json.dumps(corpo).encode('utf-8')
    req = urllib.request.Request(BASE + caminho, data=dados, method=metodo)
    req.add_header('x-admin-key', CHAVE)
    if dados is not None:
        req.add_header('Content-Type', 'application/json')
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read().decode('utf-8'))
        except Exception:
            return e.code, {}
    except Exception as e:
        return 0, {'error': str(e)}


def titulo(t):
    print('\n' + '=' * 70 + '\n' + t + '\n' + '=' * 70)


def item4():
    titulo('[4] Backup, quem recebe alerta e equipes')
    st, r = api('POST', '/api/governanca/backup')
    if st == 200 and r.get('ok'):
        b = r['backup']
        print('Backup feito e CONFERIDO: %s MB, %s tabelas, integridade %s' % (b['mb'], b['tabelas'], b['integridade']))
    else:
        print('Backup NAO conferido (HTTP %s): %s' % (st, r.get('backup', r)))

    st, r = api('GET', '/api/alertas-destinos')
    destinos = r.get('destinos', []) if st == 200 else []
    print('\nQuem recebe alerta (%d):' % len(destinos))
    for d in destinos:
        print('  #%-3s %-28s %s' % (d['id'], d['nome'], 'ativo' if d['ativo'] else 'INATIVO'))
    if not destinos:
        print('  ninguem cadastrado: sem isso nao da para montar plantao')

    st, r = api('GET', '/api/plantao/cadastro')
    equipes = r.get('equipes', []) if st == 200 else []
    escalas = r.get('escalas', []) if st == 200 else []
    print('\nEquipes (%d), turnos (%d):' % (len(equipes), len(escalas)))
    for e in equipes:
        sup = (e.get('supervisor') or {}).get('nome', '-')
        print('  %-20s supervisor: %s' % (e['nome'], sup))
    if not equipes:
        print('  nenhuma equipe: me passe nomes e horarios e eu monto')


def item5():
    titulo('[5] Tres perguntas de leigo, na mesma conversa')
    perguntas = [
        'a caixinha da Araca ta apagada?',
        'e agora?',
        'o pessoal do 731 ta sem net',
    ]
    conversa = None
    for p in perguntas:
        corpo = {'pergunta': p, 'usuario': 'teste-leigo'}
        if conversa:
            corpo['conversaId'] = conversa
        st, r = api('POST', '/api/chat', corpo, timeout=180)
        conversa = r.get('conversaId', conversa)
        ferramentas = [e.get('consulta') for e in r.get('evidencias', [])]
        print('\n> %s' % p)
        print('  veredito: %s | consultou: %s' % (r.get('veredito', '?'), ', '.join(ferramentas) or 'nada'))
        print('  ' + (r.get('texto') or r.get('error') or '(sem resposta)').replace('\n', '\n  ')[:900])

    st, r = api('GET', '/api/glossario')
    usados = [(t['termo'], t['usos']) for t in r.get('termos', []) if t.get('usos')]
    print('\nTermos do vocabulario usados ate agora: %s' % (', '.join('%s (%d)' % u for u in usados) or 'nenhum'))


def item6():
    titulo('[6] CTOs que pararam de ser coletadas')
    q = ler_env('QUESTDB_URL')
    if not q:
        print('QUESTDB_URL nao esta no .env')
        return
    sql = 'select cto_id, nome, created_at from ctos latest on created_at partition by cto_id'
    url = q.rstrip('/') + '/exec?' + urllib.parse.urlencode({'query': sql})
    try:
        with urllib.request.urlopen(url, timeout=120) as r:
            dados = json.loads(r.read().decode('utf-8')).get('dataset', [])
    except Exception as e:
        print('Nao consegui consultar o QuestDB: %s' % e)
        return
    agora = datetime.now(timezone.utc)
    paradas = []
    for cto_id, nome, em in dados:
        quando = datetime.fromisoformat(em.replace('Z', '+00:00'))
        horas = (agora - quando).total_seconds() / 3600
        if horas > 1:
            paradas.append((horas, cto_id, nome, em[:16].replace('T', ' ')))
    paradas.sort(reverse=True)
    print('%d CTOs na serie, %d sem leitura ha mais de 1 hora:' % (len(dados), len(paradas)))
    for horas, cto_id, nome, em in paradas:
        tempo = '%d dias' % (horas / 24) if horas >= 48 else '%.0f h' % horas
        print('  #%-5s %-40s ultima leitura %s UTC (ha %s)' % (cto_id, nome[:40], em, tempo))
    if paradas:
        print('\nO monitor agora avisa no WhatsApp quando uma CTO para sozinha.')
        print('A causa esta no coletor que grava no QuestDB ou na OLT dessas caixas,')
        print('nao no assistente.')


if __name__ == '__main__':
    if not CHAVE:
        print('ADMIN_API_KEY nao encontrada: rode de dentro de /opt/ura-assistente')
    else:
        item4()
        item6()
        item5()
