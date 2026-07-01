const axios = require('axios');
const fs = require('fs');

async function test() {
  const env = fs.readFileSync('.env', 'utf8');
  const org = env.match(/OPENAI_ORG_ID=(.+)/)[1].trim();
  const key = env.match(/OPENAI_ADMIN_KEY=(.+)/)[1].trim();
  
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  
  const startSec = Math.floor(start.getTime() / 1000);
  const endSec = Math.floor(end.getTime() / 1000);
  
  console.log('Start:', start);
  console.log('End:', end);
  
  try {
    const res = await axios.get('https://api.openai.com/v1/organization/costs', {
      headers: { 'Authorization': 'Bearer ' + key, 'OpenAI-Organization': org },
      params: { start_time: startSec, end_time: endSec, bucket_width: '1d', limit: 31 }
    });
    
    let total = 0;
    for (const b of res.data.data) {
       for (const r of b.results) {
          total += (r.amount.value || 0);
       }
    }
    console.log('Total:', total);
    console.log('Data:', JSON.stringify(res.data.data[0], null, 2).slice(0, 500));
  } catch(e) { console.error('Erro:', e.response?.data || e.message); }
}
test();
