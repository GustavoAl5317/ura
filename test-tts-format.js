const axios = require('axios');
const fs = require('fs');

async function test() {
  const vid = 'ORgG8rwdAiMYRug8RJwR';
  const fmt = 'pcm_24000';
  const text = 'Vou buscar as informações do seu contrato, só um momentinho.';
  const apiKey = 'sk_93b565a2b7a2ea7d8c7c0def39d270562fcaba0459d72398';

  try {
    const res = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${vid}/stream?output_format=${fmt}`,
      {
        text,
        model_id: 'eleven_flash_v2_5',
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: false,
        },
      },
      {
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        responseType: 'arraybuffer',
      }
    );

    console.log('HTTP Status:', res.status);
    console.log('Bytes:', res.data.length);
    console.log('First 20 bytes (hex):', Buffer.from(res.data).slice(0, 20).toString('hex'));
    
    // Check if it looks like MP3 (ID3 or 0xFFFB)
    const buf = Buffer.from(res.data);
    if (buf.slice(0, 3).toString() === 'ID3') {
      console.log('WARNING: This is an MP3 file (ID3 tag found)');
    } else if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) {
      console.log('WARNING: This is an MP3 file (MPEG sync found)');
    } else {
      console.log('Probably raw PCM data');
    }
    
  } catch (err) {
    console.error('Error:', err.message);
    if (err.response) {
      console.error('Data:', err.response.data.toString());
    }
  }
}

test();
