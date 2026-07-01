const axios = require('axios');
const fs = require('fs');
const env = fs.readFileSync('.env', 'utf8');
const adminKeyMatch = env.match(/OPENAI_ADMIN_KEY=(.+)/);
const orgIdMatch = env.match(/OPENAI_ORG_ID=(.+)/);

if (!adminKeyMatch || !orgIdMatch) {
    console.error('Keys not found in .env');
    process.exit(1);
}

const apiKey = adminKeyMatch[1].trim();
const orgId = orgIdMatch[1].trim();

const now = new Date();
const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 30);
const startSec = Math.floor(start.getTime() / 1000);
const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
const endSec = Math.floor(end.getTime() / 1000);

async function test() {
    try {
        const res = await axios.get('https://api.openai.com/v1/organization/costs', {
            headers: {
                'Authorization': 'Bearer ' + apiKey,
                'OpenAI-Organization': orgId
            },
            params: {
                start_time: startSec,
                end_time: endSec,
                bucket_width: '1d',
                limit: 31
            }
        });
        console.log(JSON.stringify(res.data, null, 2));
    } catch(e) {
        console.error(e.response ? e.response.data : e.message);
    }
}
test();
