// Klien Gemini AI — fallback pemahaman bahasa natural.
// Dipanggil HANYA saat router parsing lokal di bot.js menyerah, jadi hemat kuota.
// Tanpa SDK: REST generateContent via axios (sudah jadi dependency Graph API).
const axios = require('axios');
const { config } = require('./config');

const ENDPOINT_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';
const TIMEOUT_MS = 10_000;
const MAX_AMOUNT = 1e12;

// Whitelist kategori — sinkron dengan src/bot.js. Dijaga di sini agar modul
// tidak perlu mengimpor bot.js (menghindari circular dependency).
const KATEGORI_PENGELUARAN = ['makan', 'transport', 'belanja', 'tagihan', 'hiburan', 'kesehatan', 'pendidikan', 'lainnya'];
const KATEGORI_PEMASUKAN = ['gaji', 'bonus', 'transfer', 'hadiah', 'investasi', 'lainnya'];

function buildSystemPrompt(accounts) {
  const akunn = accounts.length ? accounts.join(', ') : 'bca, gopay, dana (umum)';
  return [
    'Kamu adalah pemaham pesan untuk Nooji, bot keuangan pribadi via WhatsApp berbahasa Indonesia.',
    'Tugasmu: baca SATU pesan user, lalu balas HANYA dengan JSON sesuai skema.',
    '',
    'Aturan intent:',
    '1. "transaction" — jika pesan mencatat pengeluaran/pemasukan dengan nominal yang bisa dipastikan (angka atau kata, mis. "25rb", "dua puluh lima ribu"). Isi: type ("expenses" untuk keluar, "income" untuk masuk), amount (angka rupiah penuh, bilangan bulat), category, account (nama akun/dompet jika disebut, huruf kecil; kosongkan jika tidak), note (sisa kalimat tanpa nominal/akun, maksimal 100 karakter).',
    `   - category untuk expenses harus salah satu: ${KATEGORI_PENGELUARAN.join(', ')}.`,
    `   - category untuk income harus salah satu: ${KATEGORI_PEMASUKAN.join(', ')}.`,
    `   - account hanya boleh dari yang dikenal user: ${akunn} — selain itu kosongkan.`,
    '2. "chat" — selain itu (pertanyaan, sapaan, perintah tidak jelas). Isi field "reply" dengan jawaban ramah maksimal 2 kalimat; jika pesan bukan pertanyaan yang bisa kamu jawab, akhiri dengan saran ketik "menu".',
    '3. Semua field wajib selalu ada di JSON: untuk transaction isi reply kosong string ""; untuk chat isi type "", amount 0, category "", account "", note "".',
    '4. Kamu hanya memahami teks — tidak pernah mengeksekusi apa pun. Jangan pernah mengubah saldo atau menyebut angka saldo.',
    '5. Semua teks balasan memakai bahasa Indonesia santai.',
  ].join('\n');
}

// CATATAN: Gemini menolak (400) responseSchema berisi field opsional —
// SEMUA properties wajib ada di `required`. Untuk intent chat, fields
// transaksi diisi kosong ("", amount 0); sebaliknya untuk transaction.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['transaction', 'chat'] },
    type: { type: 'string', enum: ['income', 'expenses', ''] },
    amount: { type: 'integer' },
    category: { type: 'string' },
    account: { type: 'string' },
    note: { type: 'string' },
    reply: { type: 'string' },
  },
  required: ['intent', 'type', 'amount', 'category', 'account', 'note', 'reply'],
};

// Validasi & normalisasi output Gemini — apa pun yang mencurigakan dibuang (return null).
function sanitize(parsed, accounts) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.intent === 'chat') {
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 600) : '';
    return reply ? { intent: 'chat', reply } : null;
  }
  if (parsed.intent !== 'transaction') return null;

  const type = parsed.type === 'income' ? 'income' : parsed.type === 'expenses' ? 'expenses' : null;
  const amount = Number(parsed.amount);
  if (!type || !Number.isFinite(amount) || amount <= 0 || amount > MAX_AMOUNT) return null;

  const whitelist = type === 'income' ? KATEGORI_PEMASUKAN : KATEGORI_PENGELUARAN;
  const category = whitelist.includes((parsed.category || '').toLowerCase())
    ? parsed.category.toLowerCase()
    : 'lainnya';

  const known = new Set([...accounts.map((a) => a.toLowerCase())]);
  const rawAccount = (parsed.account || '').toLowerCase().trim();
  const account = known.has(rawAccount) ? rawAccount : null;

  const note = typeof parsed.note === 'string' ? parsed.note.replace(/\s+/g, ' ').trim().slice(0, 100) : '';
  return { intent: 'transaction', type, amount: Math.round(amount), category, account, note: note || 'catatan dari AI' };
}

// Interpretasi pesan via Gemini. Return objek ternormalisasi, atau null
// (key kosong / error / timeout / output tidak valid) — caller fallback ke balasan lama.
async function interpretMessage(text, { accounts = [] } = {}) {
  if (!config.geminiApiKey) return null;
  try {
    const url = `${ENDPOINT_BASE}/${config.geminiModel}:generateContent`;
    const res = await axios.post(
      url,
      {
        contents: [{ parts: [{ text }] }],
        systemInstruction: { parts: [{ text: buildSystemPrompt(accounts) }] },
        generationConfig: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
          temperature: 0.1,
          maxOutputTokens: 300,
        },
      },
      {
        params: { key: config.geminiApiKey },
        timeout: TIMEOUT_MS,
        headers: { 'Content-Type': 'application/json' },
      }
    );
    const body = res.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!body) return null;
    return sanitize(JSON.parse(body), accounts);
  } catch (err) {
    // Tampilkan detail dari API (mis. alasan 400 pada responseSchema) supaya mudah didiagnosis.
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    console.error(`[GEMINI] Gagal (status ${err.response?.status || '-'}):`, typeof detail === 'string' ? detail : JSON.stringify(detail));
    return null;
  }
}

module.exports = { interpretMessage, sanitize, buildSystemPrompt };
