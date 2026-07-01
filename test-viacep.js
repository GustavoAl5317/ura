const axios = require('axios');
async function testViaCep() {
    try {
        const uf = 'CE';
        const cidade = 'Fortaleza';
        const rua = 'Rua 71';
        const url = https://viacep.com.br/ws////json/;
        console.log('Consultando:', url);
        const res = await axios.get(url);
        console.log('Resultado ViaCEP:', res.data);
    } catch(e) {
        console.error('Erro ViaCEP:', e.message);
    }
}
testViaCep();
