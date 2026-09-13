// Konfigurasi pusat — semua membaca process.env, dengan fallback aman.
require('dotenv').config();

const config = {
  port: Number(process.env.PORT) || 3000,
  webhookVerifyToken: process.env.WEBHOOK_VERIFY_TOKEN,
  graphApiToken: process.env.GRAPH_API_TOKEN,
  phoneNumberId: process.env.PHONE_NUMBER_ID,
  // Railway menyuntikkan DATABASE_URL otomatis saat service Postgres di-attach.
  // Jika kosong, storage fallback ke file JSON lokal — tanpa error.
  databaseUrl: process.env.DATABASE_URL,
  graphApiVersion: 'v20.0',
  timezone: 'Asia/Jakarta',
  // Gemini AI (opsional) — fallback pemahaman bahasa natural saat parsing lokal menyerah.
  // Ambil key di https://aistudio.google.com/apikey. Kosong = fitur mati, bot tetap jalan.
  geminiApiKey: process.env.GEMINI_API_KEY,
  geminiModel: process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite',
};

// Validasi saat startup — memberi peringatan jelas tanpa mengubah nama variabel.
function validateConfig() {
  const required = {
    WEBHOOK_VERIFY_TOKEN: config.webhookVerifyToken,
    GRAPH_API_TOKEN: config.graphApiToken,
    PHONE_NUMBER_ID: config.phoneNumberId,
  };
  const missing = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([key]) => key);

  if (missing.length > 0) {
    console.warn(`[CONFIG] Variabel ENV belum diisi: ${missing.join(', ')}`);
  }
  return missing.length === 0;
}

module.exports = { config, validateConfig };
