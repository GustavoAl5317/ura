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
        console.log('Consultando a OpenAI para listar todos os modelos permitidos...');
        const res = await axios.get('https://api.openai.com/v1/models', {
            headers: { 'Authorization': 'Bearer ' + apiKey }
        });
        const models = res.data.data.map(m => m.id).filter(id => id.includes('gpt-4o'));
        console.log('Modelos gpt-4o permitidos para esta chave:');
        console.log(models.join('\n'));
    } catch(e) {
        console.error('ERRO DA OPENAI:', e.response ? e.response.data : e.message);
    }
}
checkModel();
