const axios = require('axios');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const apiKeyMatch = env.match(/OPENAI_API_KEY=(.+)/);
if (!apiKeyMatch) {
    console.error('OPENAI_API_KEY not found');
    process.exit(1);
}
const apiKey = apiKeyMatch[1].trim();

async function checkTier() {
    try {
        console.log('Testando limite de taxa (Rate Limit) do gpt-4o para descobrir o Tier...');
        const res = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o',
            messages: [{ role: 'user', content: 'Oi' }],
            max_tokens: 5
        }, {
            headers: { 'Authorization': 'Bearer ' + apiKey }
        });
        
        const tpm = res.headers['x-ratelimit-limit-tokens'];
        const rpm = res.headers['x-ratelimit-limit-requests'];
        
        console.log('Limite de Tokens por Minuto (TPM):', tpm);
        console.log('Limite de Requisições por Minuto (RPM):', rpm);
        
        let tier = 'Desconhecido';
        if (tpm <= 30000) tier = 'Tier 1 (Nível Baixo - Sem Realtime)';
        else if (tpm <= 450000) tier = 'Tier 2 (Nível Médio - Realtime Liberado)';
        else if (tpm <= 2000000) tier = 'Tier 3 (Alto - Realtime Liberado)';
        else if (tpm <= 10000000) tier = 'Tier 4 (Premium - Realtime Liberado)';
        else if (tpm > 10000000) tier = 'Tier 5 (Empresarial - Realtime Liberado)';
        
        console.log('NÍVEL DA SUA CONTA:', tier);
    } catch(e) {
        console.error('ERRO DA OPENAI:', e.response ? e.response.data : e.message);
    }
}
checkTier();
