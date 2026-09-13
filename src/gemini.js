// Klien Gemini AI — pemaham utama SEMUA pesan user (mode full-AI).
// Router lokal di bot.js hanya jadi cadangan saat key kosong / Gemini error.
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

// Perintah bot yang bisa di-route lewat Gemini (intent "command").
// Nilai -> handler di src/bot.js (lihat runCommand).
const COMMANDS = ['menu', 'report', 'balance', 'list', 'account', 'budget', 'delete', 'close', 'reopen', 'archive'];

// Ringkasan fitur bot — dipakai Gemini untuk menjawab pertanyaan "cara pakai".
// Sinkronkan dengan handleHelp() di src/bot.js bila perintah berubah.
const PANDUAN_BOT = [
  'Catat transaksi (bahasa bebas): "uang masuk 10rb gaji", "parkir 2k", "beli bakso 20rb", "out 50rb makan", "in 5jt gaji". Simbol juga bisa: "+ 20rb gaji" (masuk), "- 20rb kopi" (keluar).',
  'Akun/dompet: sebutkan di pesan ("bayar bakso bca 20rb"); "akun" = daftar akun & saldo; "akun bca" = rincian; "akun baru celengan" = buat akun. Akun juga otomatis dibuat saat namanya disebut di transaksi.',
  'Laporan: "laporan" = rekap bulan ini + grafik; "laporan agustus" = bulan tertentu; "saldo" = saldo & statistik; "transaksi" = 8 transaksi terakhir.',
  'Anggaran: "anggaran makan 1jt" = pasang budget; "anggaran" = cek status.',
  'Hapus: "hapus <id>" (id ada di daftar transaksi).',
  'Tutup buku: "tutup buku" = kunci bulan berjalan; "tutup agustus"; "arsip" = riwayat; "buka agustus" = buka lagi.',
  'Kategori pengeluaran: makan, transport, belanja, tagihan, hiburan, kesehatan, pendidikan, lainnya. Pemasukan: gaji, bonus, transfer, hadiah, investasi, lainnya.',
  '"menu" atau "bantuan" = daftar semua perintah.',
].join('\n');

function buildSystemPrompt(accounts) {
  const akunn = accounts.length ? accounts.join(', ') : 'bca, gopay, dana (umum)';
  return [
    'Kamu adalah pemaham pesan untuk Nooji, bot keuangan pribadi via WhatsApp berbahasa Indonesia.',
    'Kamu menerima SETIAP pesan user dan yang menentukan maksudnya. Balas HANYA dengan satu objek JSON mentah sesuai skema — tanpa teks pembuka/penutup, tanpa code fence markdown.',
    '',
    'Aturan intent (pilih salah satu):',
    '1. "command" — jika user meminta aksi laporan/data bot: melihat daftar atau angka (bukan mencatat nominal baru). Pemetaan:',
    `   - "menu" (bantuan, apa saja yang bisa kamu lakukan), "report" ("laporan <bulan?>" — rekap bulanan), "balance" ("saldo", "berapa uangku sekarang"), "list" ("transaksi terakhir"),`,
    `   - "account" ("akun", "akun <nama>", "akun baru <nama>" → args: "baru <nama>" / "<nama>" / ""),`,
    `   - "budget" ("anggaran" cek → args: ""; "anggaran makan 1jt" pasang → args: "makan 1jt"),`,
    `   - "delete" ("hapus transaksi nomor 3" → args: "3"),`,
    `   - "close" ("tutup buku <bulan?>"), "reopen" ("buka <bulan>"), "archive" ("arsip").`,
    '   Isi command + args (args = sisa yang diperlukan handler, mis. id, nama akun, nominal; kosongkan jika tidak ada).',
    '2. "transaction" — mencatat pengeluaran/pemasukan dengan nominal (angka atau kata, mis. "25rb", "dua puluh lima ribu"). Isi: type ("expenses" keluar / "income" masuk), amount (rupiah penuh, bulat), category, account (huruf kecil, kosongkan jika tidak disebut), note (sisa kalimat tanpa nominal/akun, maks 100 karakter).',
    `   - category expenses salah satu: ${KATEGORI_PENGELUARAN.join(', ')}; category income salah satu: ${KATEGORI_PEMASUKAN.join(', ')}.`,
    `   - account hanya dari yang dikenal: ${akunn} — selain itu kosongkan.`,
    '3. "chat" — sapaan, opini, pertanyaan cara pakai bot, atau hal di luar dua intent di atas. Isi "reply".',
    '',
    'Aturan umum:',
    '- Semua field wajib ada di JSON. Field enum kosong ditulis "none": transaction → reply "" dan command "none" dan args ""; chat → type "none", amount 0, category "", account "", note "", command "none", args ""; command → type "none", amount 0, category "", account "", note "", reply "".',
    '- Ambiguo antara command dan transaction? Jika menyebut NOMINAL BELANJA/masuk → transaction. Jika bertanya angka/data → command.',
    '- Untuk chat cara pakai bot, JAWAB spesifik dari panduan fitur di bawah (maks 4 kalimat, sebutkan format perintah persis) — jangan sekadar suruh ketik "menu".',
    '- Kamu hanya memahami teks — tidak pernah mengeksekusi atau menyebut angka saldo asli.',
    '- Bahasa Indonesia santai.',
    '',
    'Panduan fitur bot:',
    PANDUAN_BOT,
  ].join('\n');
}

// CATATAN: Gemini menolak (400) responseSchema berisi field opsional —
// SEMUA properties wajib ada di `required`. Untuk intent chat, fields
// transaksi diisi kosong ("", amount 0); sebaliknya untuk transaction.
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['command', 'transaction', 'chat'] },
    // Catatan: Gemini menolak '' di dalam enum — pakai sentinel "none" untuk "bukan command".
    command: { type: 'string', enum: [...COMMANDS, 'none'] },
    args: { type: 'string' },
    type: { type: 'string', enum: ['income', 'expenses', 'none'] },
    amount: { type: 'integer' },
    category: { type: 'string' },
    account: { type: 'string' },
    note: { type: 'string' },
    reply: { type: 'string' },
  },
  required: ['intent', 'command', 'args', 'type', 'amount', 'category', 'account', 'note', 'reply'],
};

// Validasi & normalisasi output Gemini — apa pun yang mencurigakan dibuang (return null).
function sanitize(parsed, accounts) {
  if (!parsed || typeof parsed !== 'object') return null;
  if (parsed.intent === 'chat') {
    const reply = typeof parsed.reply === 'string' ? parsed.reply.trim().slice(0, 600) : '';
    return reply ? { intent: 'chat', reply } : null;
  }
  if (parsed.intent === 'command') {
    if (!COMMANDS.includes(parsed.command)) return null;
    const args = typeof parsed.args === 'string' ? parsed.args.replace(/\s+/g, ' ').trim().slice(0, 120) : '';
    return { intent: 'command', command: parsed.command, args };
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

// Beberapa model (terutama flash-lite) kadang mengabaikan responseMimeType dan
// membalas prosa/"```json" di sekitar objeknya. Ambil substring {...} terluar.
function parseModelJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return null;
    }
  }
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
          // 9 field wajib + reply chat bisa panjang; 300 terbukti memotong JSON di tengah.
          maxOutputTokens: 1024,
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
    const parsed = parseModelJson(body);
    if (!parsed) {
      console.error('[GEMINI] Output bukan JSON:', JSON.stringify(body.slice(0, 200)));
      return null;
    }
    return sanitize(parsed, accounts);
  } catch (err) {
    // Tampilkan detail dari API (mis. alasan 400 pada responseSchema) supaya mudah didiagnosis.
    const detail = err.response?.data?.error?.message || err.response?.data || err.message;
    console.error(`[GEMINI] Gagal (status ${err.response?.status || '-'}):`, typeof detail === 'string' ? detail : JSON.stringify(detail));
    return null;
  }
}

module.exports = { interpretMessage, sanitize, buildSystemPrompt };
