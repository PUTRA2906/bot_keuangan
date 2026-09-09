// Konfigurasi pusat — HANYA memakai variabel ENV yang sudah ada, tidak ada penambahan.
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
