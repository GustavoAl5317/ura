#!/usr/bin/env python3
"""Refaz, na 005-MANAGER, as perguntas de leigo que vieram erradas no WhatsApp.

  [1] as perguntas de 01/10, numa conversa so (o "e essas caixas?" depende
      da pergunta anterior), pelo canal do painel: ninguem recebe mensagem
  [2] as ultimas consultas do WhatsApp que deram INCONCLUSIVO, com o que o
      assistente consultou e o erro de cada fonte

Uso, de dentro de /opt/ura-assistente:
    python3 scripts/testar_leigo.py

Nao imprime chave nenhuma. So le o banco (modo somente leitura).
"""

import json
import re
import sqlite3
import urllib.request

BASE = 'http://127.0.0.1:9030'

PERGUNTAS = [
    'Como é que tá a situação da rede lá do bom sucesso?',
    'Me diga uma coisa, no bairro Bolsa Fesso, quantos cancelamentos tiveram hoje?',
    'Quantas caixas tem no bairro Bom Sucesso? E dessas caixas, quantas têm só dois clientes?',
    'Qual é a caixa que só tem um cliente na Rua Bias Mendes?',
    'Quantas CTOs nós temos com luz alta?',
    'Quais são os endereços onde encontra essas caixas?',
    'Quais são os casos que tem no bairro Jardim Guanabara?',
    'É, poderia me dizer qual é a rede que está no bairro João 23?',
    'Quantas caixas de emenda nós temos na nossa rede na área da Parangaba? Caixas de emenda, CLO, né?',
    'Onde fica a caixa de emenda lá da Angola Cable Hotel Cables, em frente à Praia do Futuro?',
    'Como é que tá a rede da RNP?',
    'Como é que se encontra a rede da Etice?',
    'Como é que tá a luz da caixa da segunda etapa do Conjunto Ceará?',
    'A nossa OLT da Huawei, ela atende quais os bairros?',
    'Tem como mapear a OLT1, ela tem quais são os bairros?',
    'A rede da RNP, ela está em qual equipamento dentro do nosso datacenter?',
    'Poderia me informar sobre a rede da AT&T?',
    'Em quais bairros nós temos clientes? Quero todos.',
    'Como é que está a rede da ETIS?',
    'Como é que está as interfaces e quantas interfaces estão conectadas no switch da Huawei 6720?',
]


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


def api(metodo, caminho, corpo=None, timeout=180):
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


def item1():
    titulo('[1] Perguntas de leigo de 01/10, numa conversa so')
    conversa = None
    contagem = {}
    for p in PERGUNTAS:
        corpo = {'pergunta': p, 'usuario': 'teste-leigo-0110'}
        if conversa:
            corpo['conversaId'] = conversa
        st, r = api('POST', '/api/chat', corpo)
        conversa = r.get('conversaId', conversa)
        v = r.get('veredito', '?')
        contagem[v] = contagem.get(v, 0) + 1
        consultas = ['%s%s%s' % (e.get('consulta'), ' ' + json.dumps(e.get('args'), ensure_ascii=False)[:80] if e.get('args') else '', '' if e.get('ok', True) else ' (FALHOU)') for e in r.get('evidencias', [])]
        print('\n> %s' % p)
        print('  veredito: %s | consultou: %s' % (v, ', '.join(consultas) or 'nada'))
        print('  ' + (r.get('texto') or r.get('error') or '(sem resposta)').replace('\n', '\n  ')[:700])
    print('\nResumo: ' + ', '.join('%s %d' % kv for kv in sorted(contagem.items())))


def item2():
    titulo('[2] Ultimas consultas do WhatsApp com INCONCLUSIVO')
    try:
        con = sqlite3.connect('file:data/assistant.db?mode=ro', uri=True)
    except Exception as e:
        print('Nao abri o banco: %s' % e)
        return
    linhas = con.execute(
        "SELECT id, at, pergunta FROM consulta WHERE canal = 'whatsapp' AND veredito = 'INCONCLUSIVO' "
        "ORDER BY at DESC LIMIT 25"
    ).fetchall()
    print('%d consultas' % len(linhas))
    for cid, at, pergunta in linhas:
        evs = con.execute(
            'SELECT nome_consulta, ok, vazio, erro FROM evidencia WHERE consulta_id = ? ORDER BY evd', (cid,)
        ).fetchall()
        print('\n%s  %s' % (at[:16].replace('T', ' '), pergunta[:160]))
        if not evs:
            print('    (nao consultou nenhuma fonte)')
        for nome, ok, vazio, erro in evs:
            estado = 'ERRO: %s' % (erro or '')[:140] if not ok else ('vazio' if vazio else 'ok')
            print('    %-32s %s' % (nome, estado))
    con.close()


if __name__ == '__main__':
    if not CHAVE:
        print('ADMIN_API_KEY nao encontrada: rode de dentro de /opt/ura-assistente')
    else:
        item2()
        item1()
