const axios = require('axios');
async function test() {
  try {
    const q = encodeURIComponent('Rua das Flores, Centro, Fortaleza, CE, Brasil');
    const res = await axios.get('https://nominatim.openstreetmap.org/search?format=json&addressdetails=1&q=' + q, { headers: {'User-Agent': 'URA-AI-Test/1.0'} });
    console.log(JSON.stringify(res.data, null, 2));
  } catch(e) { console.error(e.message); }
}
test();
