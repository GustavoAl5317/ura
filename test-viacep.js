const axios = require('axios');
async function test() {
  try {
    const res = await axios.get('https://viacep.com.br/ws/CE/Fortaleza/Domingos Olimpio/json/');
    console.log(JSON.stringify(res.data, null, 2));
  } catch(e) { console.error(e.message); }
}
test();
