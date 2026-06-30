const axios = require('axios');
const fs = require('fs');

async function testCosts() {
  const env = fs.readFileSync('.env', 'utf8');
  const apiKeyMatch = env.match(/OPENAI_ADMIN_KEY=(.+)/);
  const orgIdMatch = env.match(/OPENAI_ORG_ID=(.+)/);
  
  const headers = { Authorization: 'Bearer ' + apiKeyMatch[1].trim() };
  if (orgIdMatch) headers['OpenAI-Organization'] = orgIdMatch[1].trim();

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const startSec = Math.floor(start.getTime() / 1000);
  const endSec = Math.floor(now.getTime() / 1000);

  const params = new URLSearchParams({
    start_time: startSec,
    end_time: endSec,
    bucket_width: '1d',
    limit: 31,
  });

  try {
    const res = await axios.get('https://api.openai.com/v1/organization/costs?' + params.toString(), { headers });
    console.log('Status:', res.status);
    console.log('Data:', JSON.stringify(res.data, null, 2).slice(0, 500));
  } catch(err) {
    console.log('Error status:', err.response?.status);
    console.log('Error data:', JSON.stringify(err.response?.data, null, 2));
  }
}
testCosts();
