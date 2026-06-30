const axios = require('axios');
const fs = require('fs');

async function testOpenAi() {
  const env = fs.readFileSync('.env', 'utf8');
  const apiKeyMatch = env.match(/OPENAI_ADMIN_KEY=(.+)/);
  const orgIdMatch = env.match(/OPENAI_ORG_ID=(.+)/);
  
  if (!apiKeyMatch) return console.log('No admin key');
  
  const headers = { Authorization: 'Bearer ' + apiKeyMatch[1].trim() };
  if (orgIdMatch) headers['OpenAI-Organization'] = orgIdMatch[1].trim();

  const params = new URLSearchParams();
  params.set('limit', '10');
  params.append('event_types[]', 'login.succeeded');
  params.append('event_types[]', 'login.failed');

  console.log('Fetching URL:', 'https://api.openai.com/v1/organization/audit_logs?' + params.toString());
  
  try {
    const res = await axios.get('https://api.openai.com/v1/organization/audit_logs?' + params.toString(), { headers });
    console.log('Status:', res.status);
    console.log('Data:', JSON.stringify(res.data, null, 2));
  } catch(err) {
    console.log('Error status:', err.response?.status);
    console.log('Error data:', JSON.stringify(err.response?.data, null, 2));
  }
}
testOpenAi();
