const axios = require('axios');
const fs = require('fs');

async function testCosts() {
  const env = fs.readFileSync('.env', 'utf8');
  const apiKeyMatch = env.match(/OPENAI_ADMIN_KEY=(.+)/);
  
  const headers = { Authorization: 'Bearer ' + apiKeyMatch[1].trim() };

  const now = new Date();
  const startSec = Math.floor(new Date(now.getFullYear(), now.getMonth(), 1).getTime() / 1000);
  const endSec = Math.floor(now.getTime() / 1000);

  const params = new URLSearchParams({
    start_time: startSec,
    end_time: endSec,
    bucket_width: '1d'
  });

  try {
    const res = await axios.get('https://api.openai.com/v1/organization/costs?' + params.toString(), { headers });
    console.log('Without group_by:', JSON.stringify(res.data.data[res.data.data.length - 1]));
  } catch(err) { console.log('Err1', err.response?.status) }

  try {
    const p2 = new URLSearchParams(params);
    p2.append('group_by', 'project');
    const res = await axios.get('https://api.openai.com/v1/organization/costs?' + p2.toString(), { headers });
    console.log('With group_by=project:', JSON.stringify(res.data.data[res.data.data.length - 1]));
  } catch(err) { console.log('Err2', err.response?.status) }

  try {
    const p3 = new URLSearchParams(params);
    p3.append('group_by', 'line_item');
    const res = await axios.get('https://api.openai.com/v1/organization/costs?' + p3.toString(), { headers });
    console.log('With group_by=line_item:', JSON.stringify(res.data.data[res.data.data.length - 1]));
  } catch(err) { console.log('Err3', err.response?.status) }
}
testCosts();
