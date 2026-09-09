// Pengiriman pesan WhatsApp via Meta Graph API (satu-satunya jalur keluar).
const axios = require('axios');
const { config } = require('./config');

async function sendText(to, body) {
  const url = `https://graph.facebook.com/${config.graphApiVersion}/${config.phoneNumberId}/messages`;
  try {
    await axios({
      method: 'POST',
      url,
      headers: {
        Authorization: `Bearer ${config.graphApiToken}`,
        'Content-Type': 'application/json',
      },
      data: {
        messaging_product: 'whatsapp',
        to,
        type: 'text',
        text: { body: body.slice(0, 4096) }, // batas panjang pesan WhatsApp
      },
      timeout: 15000,
    });
    return true;
  } catch (err) {
    console.error('[WHATSAPP] Gagal kirim pesan:', err.response?.data || err.message);
    return false;
  }
}

module.exports = { sendText };
