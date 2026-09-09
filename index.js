const express = require('express');
const axios = require('axios');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN;
const GRAPH_API_TOKEN = process.env.GRAPH_API_TOKEN;
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID;

// 1. Endpoint Verifikasi Webhook Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === WEBHOOK_VERIFY_TOKEN) {
      console.log('WEBHOOK_VERIFIED');
      res.status(200).send(challenge);
    } else {
      res.sendStatus(403);
    }
  } else {
    res.sendStatus(400);
  }
});

// 2. Endpoint Menerima Pesan Masuk dari WhatsApp
app.post('/webhook', async (req, res) => {
  const body = req.body;

  if (body.object === 'whatsapp_business_account') {
    const entry = body.entry?.[0];
    const changes = entry?.changes?.[0];
    const value = changes?.value;
    const message = value?.messages?.[0];

    // Mencegah error jika pesan bukan berupa teks atau berupa notifikasi status (delivered/read)
    if (message && message.type === 'text') {
      const from = message.from; // Nomor pengirim
      const msgBody = message.text.body; // Teks pesan
      console.log(`Pesan dari ${from}: ${msgBody}`);

      // Logika pemrosesan pesan bot keuangan (Logika Sederhana)
      let replyText = `Pesan kamu diterima: "${msgBody}"\n\n_Ketik perintah transaksi untuk mencatat keuangan._`;

      if (msgBody.toLowerCase().includes('catat')) {
        replyText = `✅ *Catatan Berhasil!*\nTransaksi "${msgBody}" telah disimpan ke log keuangan Nooji.`;
      }

      // Kirim balasan otomatis
      await sendWhatsAppMessage(from, replyText);
    }

    res.sendStatus(200);
  } else {
    res.sendStatus(404);
  }
});

// 3. Fungsi Kirim Pesan Balasan via Meta API
async function sendWhatsAppMessage(to, text) {
  try {
    await axios({
      method: 'POST',
      url: `https://graph.facebook.com/v20.0/${PHONE_NUMBER_ID}/messages`,
      headers: {
        'Authorization': `Bearer ${GRAPH_API_TOKEN}`,
        'Content-Type': 'application/json',
      },
      data: {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: text },
      },
    });
  } catch (error) {
    console.error('Error saat mengirim pesan WhatsApp:', error.response?.data || error.message);
  }
}

// Check Health Server
app.get('/', (req, res) => {
  res.send('Server Nooji Bot Aktif!');
});

app.listen(PORT, () => {
  console.log(`Server berjalan di port ${PORT}`);
});
