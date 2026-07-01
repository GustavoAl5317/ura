const axios = require('axios');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const apiKeyMatch = env.match(/OPENAI_API_KEY=(.+)/);
if (!apiKeyMatch) {
    console.error('OPENAI_API_KEY not found');
    process.exit(1);
}
const apiKey = apiKeyMatch[1].trim();

async function checkModel() {
    try {
        console.log('Consultando a OpenAI sobre o modelo gpt-4o-mini-realtime-preview...');
        const res = await axios.get('https://api.openai.com/v1/models/gpt-4o-mini-realtime-preview', {
            headers: { 'Authorization': 'Bearer ' + apiKey }
        });
        console.log('O MODELO MINI EXISTE PARA ESTA CHAVE? SIM! ID:', res.data.id);
    } catch(e) {
        console.log('O MODELO MINI EXISTE PARA ESTA CHAVE? NÃO!', e.response ? e.response.data : e.message);
    }
}
checkModel();
