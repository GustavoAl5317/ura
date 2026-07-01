const axios = require('axios');
const dotenv = require('dotenv');
dotenv.config();

const url = 'https://evo.aquitelecom.com/message/sendText/Aquitelecom';
const headers = {
  apikey: '4537D06CD6A24D977415CAAFCCE10F7D57E11',
  'Content-Type': 'application/json'
};

async function testModern() {
  try {
    const res = await axios.post(url, { number: '120363429705241071@g.us', text: 'Teste modern' }, { headers });
    console.log('Modern OK:', res.data);
  } catch (err) {
    if (err.response) {
      console.log('Modern Error Response:', err.response.status, err.response.data);
    } else {
      console.log('Modern Error:', err.message);
    }
  }
}

testModern();
