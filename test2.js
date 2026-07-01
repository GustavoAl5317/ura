const axios = require('axios');
async function test() {
    try {
        const res = await axios.get('https://viacep.com.br/ws/CE/Fortaleza/Rua%20222/json/');
        console.log(res.data);
    } catch(e) {
        console.log('Erro:', e.message);
    }
}
test();
