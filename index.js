// Nooji — Bot Keuangan WhatsApp (entry point)
// Variabel ENV yang dipakai: PORT, WEBHOOK_VERIFY_TOKEN, GRAPH_API_TOKEN, PHONE_NUMBER_ID
const express = require('express');
const { config, validateConfig } = require('./src/config');
const { handleWebhookEvent } = require('./src/bot');

const app = express();
app.use(express.json());

// 1. Endpoint Verifikasi Webhook Meta
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  if (mode && token) {
    if (mode === 'subscribe' && token === config.webhookVerifyToken) {
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
  const body = req.body || {};

  if (body.object !== 'whatsapp_business_account') {
    return res.sendStatus(404);
  }

  // ACK cepat ke Meta, proses pesan di background agar tidak timeout
  res.sendStatus(200);

  try {
    await handleWebhookEvent(body);
  } catch (err) {
    console.error('[WEBHOOK] Error memproses event:', err);
  }
});

// 3. Health check
app.get('/', (req, res) => {
  res.json({ status: 'ok', service: 'nooji-bot-keuangan', time: new Date().toISOString() });
});

app.listen(config.port, () => {
  const ready = validateConfig();
  console.log(`🤖 Server Nooji Bot Keuangan berjalan di port ${config.port}`);
  if (!ready) {
    console.warn('⚠️  Beberapa ENV belum diisi — bot akan menolak kirim pesan sampai lengkap.');
  }
});
