import * as fs from 'fs';
const file = 'src/tools/handlers.ts';
let content = fs.readFileSync(file, 'utf8');

const regex = /const endStr = \[logradouro, numero, bairro, cidade\].filter\(Boolean\).join\(\', \'\);\s*const cepStr = args.cep \? String\(args.cep\) : \'\;/s;

const replacement = const endStr = [logradouro, numero, bairro, cidade].filter(Boolean).join(', ');
    let cepStr = args.cep ? String(args.cep) : '';
    
    // Tentar descobrir CEP via ViaCEP se o usuario nao informou, mas deu logradouro e cidade
    if (!cepStr && logradouro && cidade) {
      try {
        const ax = require('axios');
        const url = 'https://viacep.com.br/ws/' + config.defaultUf + '/' + encodeURIComponent(cidade) + '/' + encodeURIComponent(logradouro) + '/json/';
        const resp = await ax.get(url, { timeout: 3000 });
        if (Array.isArray(resp.data) && resp.data.length > 0) {
          // Se tiver bairro, tenta achar o mais proximo, senao pega o primeiro
          let match = resp.data[0];
          if (bairro) {
            const mBairro = resp.data.find(d => d.bairro && d.bairro.toLowerCase().includes(bairro.toLowerCase()));
            if (mBairro) match = mBairro;
          }
          cepStr = match.cep.replace(/\D/g, '');
          ctx.log.push('ViaCEP fallback descobriu o CEP: ' + cepStr + ' (' + match.logradouro + ')');
        }
      } catch (err) {
        ctx.log.push('ViaCEP fallback falhou: ' + (err.message || ''));
      }
    }
;

content = content.replace(regex, replacement);
fs.writeFileSync(file, content);
console.log('handlers.ts updated');
