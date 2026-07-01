const axios = require('axios');
const fs = require('fs');

async function testGeosite() {
    const env = fs.readFileSync('.env', 'utf8');
    const btoa = (str) => Buffer.from(str).toString('base64');
    
    const userMatch = env.match(/GEOSITE_USERNAME=(.+)/);
    const passMatch = env.match(/GEOSITE_PASSWORD=(.+)/);
    
    if (!userMatch || !passMatch) return;
    
    const user = userMatch[1].trim();
    const pass = passMatch[1].trim();
    const token = btoa(user + ':' + pass);
    
    try {
        const url = 'https://telecom.digicade.com.br/geosite-telecom-api/v2/network/ftth/box/coverage/viability?zipCode=60530430&radius=600';
        const res = await axios.get(url, { headers: { 'Authorization': 'Basic ' + token } });
        console.log('GEOSITE RESPONDEU:', JSON.stringify(res.data, null, 2));
    } catch(e) {
        console.log('Erro Geosite:', e.response ? e.response.data : e.message);
    }
}
testGeosite();
