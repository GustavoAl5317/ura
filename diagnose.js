const axios = require('axios');
const fs = require('fs');

const env = fs.readFileSync('.env', 'utf8');
const apiKeyMatch = env.match(/OPENAI_API_KEY=(.+)/);

if (!apiKeyMatch) {
    process.exit(1);
}

const apiKey = apiKeyMatch[1].trim();

async function checkLim() {
    try {
        const resLim = await axios.post('https://api.openai.com/v1/chat/completions', {
            model: 'gpt-4o-mini', messages: [{role: 'user', content: 'test'}], max_tokens: 1
        }, { headers: { 'Authorization': 'Bearer ' + apiKey } });
        
        console.log('Limite de Tokens (TPM):', resLim.headers['x-ratelimit-limit-tokens']);
        console.log('Limite de Requisicoes (RPM):', resLim.headers['x-ratelimit-limit-requests']);
    } catch(e) {
        console.log('Erro Limites:', e.response?.data || e.message);
    }
}
checkLim();
