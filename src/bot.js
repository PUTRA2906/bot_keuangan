// Mesin utama bot keuangan: routing perintah, pencatatan, laporan, anggaran.
// Semua akses data lewat src/storage.js (PostgreSQL di Railway, JSON fallback lokal).
const { extractAmount, formatRupiah, formatShort } = require('./money');
const storage = require('./storage');
const { sendText } = require('./whatsapp');

// ---- Domain ----
const KATEGORI_PENGELUARAN = [
  'makan', 'transport', 'belanja', 'tagihan', 'hiburan',
  'kesehatan', 'pendidikan', 'lainnya',
];
const KATEGORI_PEMASUKAN = ['gaji', 'bonus', 'transfer', 'hadiah', 'investasi', 'lainnya'];

// Kata pemicu arah untuk kalimat natural tanpa perintah kaku:
// "parkir 2k" → keluar, "gaji bulanan 10rb" → masuk. Kata yang muncul lebih dulu menentukan.
const NAT_IN_WORDS = new Set(['masuk', 'gaji', 'upah', 'pendapatan', 'bonus', 'hadiah', 'transfer', 'terima', 'dapat', 'penjualan', 'cashback', 'thr', 'menang', 'kemenangan', 'rewards']);
const NAT_OUT_WORDS = new Set(['keluar', 'beli', 'bayar', 'jajan', 'parkir', 'belanja', 'sewa', 'langganan', 'topup', 'isi', 'makan', 'minum', 'kopi', 'nonton', 'cicilan', 'kredit']);

// Sinonim → kategori, supaya "bakso" otomatis masuk kategori makan, dsb.
const CATEGORY_HINTS = {
  makan: ['makan', 'minum', 'bakso', 'nasi', 'kopi', 'esteh', 'teh', 'mie', 'mi', 'roti', 'sate', 'gorengan', 'jajan', 'warung', 'warteg', 'soto', 'sop', 'ayam', 'ikan', 'sego', 'burger', 'pizza', 'martabak', 'batagor', 'seblak', 'caf', 'resto', 'kantin'],
  transport: ['transport', 'parkir', 'bensin', 'bbm', 'tol', 'karcis', 'ojol', 'gojek', 'grab', 'bus', 'kereta', 'ktmu', 'krl', 'angkot', 'travel', 'bensin'],
  belanja: ['belanja', 'beli', 'pembelian', 'tokopedia'],
  tagihan: ['tagihan', 'listrik', 'pln', 'pdam', 'air', 'internet', 'wifi', 'sewa', 'kos', 'kredit', 'cicilan', 'paylater', 'pulsa', 'paket'],
  hiburan: ['hiburan', 'nonton', 'bioskop', 'game', 'karaoke', 'liburan', 'hotel', 'staycation'],
  kesehatan: ['kesehatan', 'obat', 'dokter', 'apotek', 'vitamin'],
  pendidikan: ['pendidikan', 'kuliah', 'sekolah', 'spp', 'kursus', 'buku', 'les'],
  gaji: ['gaji', 'upah', 'pendapatan', 'honor', 'insentif'],
  bonus: ['bonus'],
  transfer: ['transfer', 'kiriman'],
  hadiah: ['hadiah', 'kado', 'undian', 'menang', 'kemenangan'],
  investasi: ['investasi', 'dividen', 'saham', 'deposito'],
};

// Nama akun (bank/e-wallet/tunai) yang dikenali otomatis di dalam pesan.
const DEFAULT_ACCOUNTS = ['bca', 'bri', 'bni', 'btn', 'mandiri', 'permata', 'danamon', 'jenius', 'jago', 'sea', 'gopay', 'ovo', 'dana', 'shopeepay', 'atm', 'tunai', 'cash', 'rekening', 'emas'];
// Kata kerja yang dibuang dari catatan (termasuk berimbuhan: beliin, bayarin, jajanin).
const ACTION_WORDS = /\b(?:beli(?:in|an|nya)?|bayar(?:in|annya)?|jajan(?:an|in)?|uang masuk|uang keluar|duit masuk|duit keluar)\b/gi;
const ALIAS = {
  expenses: ['keluar', 'out', 'pengeluaran', 'e'],
  income: ['masuk', 'in', 'pemasukan', 'i'],
  report: ['laporan', 'report', 'r', 'rekap'],
  budget: ['anggaran', 'budget', 'b'],
  balance: ['saldo', 'balance', 's'],
  list: ['transaksi', 'tx', 'list', 'l'],
  delete: ['hapus', 'delete', 'd'],
  help: ['help', 'bantuan', 'menu', 'h'],
  archive: ['arsip', 'riwayat tutup'],
  account: ['akun', 'account'],
};

function matchAlias(cmd, list) {
  return list.some((a) => cmd === a || cmd.startsWith(`${a} `));
}

function parseArgs(text) {
  const parts = text.trim().split(/\s+/);
  return { cmd: (parts[0] || '').toLowerCase(), rest: parts.slice(1) };
}

// Tentukan arah dari kalimat natural (tanpa perintah kaku). Kata pemicu yang
// muncul lebih dulu menang — mis. "bayar gaji" → bayar(keluar) lebih dulu → pengeluaran.
// Awalan juga dihitung ("gajian" → gaji, "beliin" → beli) selama sisanya pendek.
function matchTrigger(word, set) {
  if (set.has(word)) return true;
  for (const t of set) {
    if (word.length > t.length && word.length - t.length <= 3 && word.startsWith(t)) return true;
  }
  return false;
}

function classifyNatural(text) {
  const words = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/);
  for (const w of words) {
    if (matchTrigger(w, NAT_IN_WORDS)) return 'income';
    if (matchTrigger(w, NAT_OUT_WORDS)) return 'expenses';
  }
  return null;
}

// Cocokkan kategori dari kata-kata dalam catatan (paling spesifik lebih dulu).
function guessCategory(type, haystack) {
  const list = type === 'income' ? KATEGORI_PEMASUKAN : KATEGORI_PENGELUARAN;
  const tokens = haystack.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(/\s+/);
  for (const cat of list) {
    const hints = CATEGORY_HINTS[cat] || [cat];
    if (tokens.some((t) => hints.includes(t)) || haystack.toLowerCase().includes(cat)) return cat;
  }
  return null;
}

// Ambil nama akun dari teks (mis. "bca", "gopay"). Dikembalikan {account, rest}.
// Nama akun dinormalisasi lowercase; sisa teks mempertahankan huruf aslinya.
function extractAccount(userIdAccounts, text) {
  const known = new Set([...DEFAULT_ACCOUNTS, ...userIdAccounts.map((a) => a.toLowerCase())]);
  const raw = text.split(/\s+/).filter(Boolean);
  let account = null;
  const rest = [];
  for (const w of raw) {
    const t = w.toLowerCase();
    if (!account && known.has(t)) { account = t; continue; }
    rest.push(w);
  }
  return { account, rest: rest.join(' ') };
}

function monthKey(date = new Date()) {
  // Selalu WIB (Asia/Jakarta) — server Railway bisa berjalan di UTC.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(date).slice(0, 7);
}

// 'YYYY-MM' dari tanggal ISO apa pun, dihitung dalam WIB.
function ymOf(dateLike) {
  return monthKey(new Date(dateLike));
}

function dayOfMonth() {
  return Number(new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Jakarta' }).format(new Date()).slice(8, 10));
}

function todayLabel() {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta', weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  }).format(new Date());
}

function timeLabel(date = new Date()) {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit',
  }).format(date);
}

function dayLabel(date) {
  return new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short' }).format(date);
}

const NAMA_BULAN = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function labelBulan(key) {
  const [y, m] = key.split('-');
  return `${NAMA_BULAN[Number(m) - 1]} ${y}`;
}
function parseMonthFilter(text) {
  // menerima "2026-09" atau nama bulan ("september", minimal 4 huruf)
  const ym = text.match(/(\d{4})-(\d{1,2})/);
  if (ym) return `${ym[1]}-${String(Number(ym[2])).padStart(2, '0')}`;
  const idx = NAMA_BULAN.findIndex((n) => text.toLowerCase().includes(n.toLowerCase().slice(0, 4)));
  if (idx >= 0) return `${monthKey().slice(0, 4)}-${String(idx + 1).padStart(2, '0')}`;
  return null;
}

// ---- Transaksi (in/out) ----
// Format: "out 20rb makan siang" atau "out makan 20rb" — nominal & kategori fleksibel posisinya.
async function handleTransaction(userId, type, text) {
  // Bulan tertutup = terkunci dari pencatatan baru (prinsip dasar tutup buku).
  if (await storage.isMonthClosed(userId, monthKey())) {
    return `🔒 Bulan *${labelBulan(monthKey())}* sudah ditutup — pencatatan dikunci.\nBuka dulu: _buka ${monthKey()}_`;
  }

  // Tolak nominal negatif eksplisit: "in -50rb" bukan pemasukan minus, tapi salah ketik.
  if (/[-−–]\s*\d/.test(text)) {
    return `⚠️ Nominal tidak boleh negatif.\nContoh: _${type === 'expenses' ? 'out 50rb makan siang' : 'in 5jt gaji'}_`;
  }

  const found = extractAmount(text);
  if (!found) {
    return `⚠️ Nominal tidak ditemukan.\n\nContoh:\n_${type === 'expenses' ? 'out 50rb makan siang' : 'in 5jt gaji'}_`;
  }
  if (found.amount > 1e12) {
    return '⚠️ Nominal terlalu besar (maksimum Rp 1 triliun). Periksa kembali angkanya.';
  }

  const lower = text.toLowerCase();
  let category = type === 'income' ? 'gaji' : 'lainnya';
  const hit = (type === 'income' ? KATEGORI_PEMASUKAN : KATEGORI_PENGELUARAN).find((k) => lower.includes(k));
  if (hit) category = hit;
  // Kalau kata kategori kaku tidak ada, tebak dari kata-kata catatan ("bakso" → makan).
  if (!hit) {
    const sisa = text.replace(found.matched, ' ').replace(ACTION_WORDS, ' ');
    const guessed = guessCategory(type, sisa);
    if (guessed) category = guessed;
  }

  // Nama akun: kenali dari teks + daftar akun milik user.
  const userAccounts = await storage.listAccounts(userId);
  const { account, rest: afterAccount } = extractAccount(userAccounts, text.replace(found.matched, ' '));

  // Catatan = sisa teks tanpa nominal, tanpa akun, tanpa kata kategori/kata kerja/kata depan.
  let note = afterAccount
    .replace(new RegExp(`\\b${category}\\b`, 'i'), ' ')
    .replace(ACTION_WORDS, ' ')
    .replace(/\b(?:dari|buat|untuk|sama|dengan)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!note) note = 'tanpa catatan';

  const date = new Date().toISOString();
  const id = await storage.addTx(userId, { type, amount: found.amount, category, account: account || null, note: note.slice(0, 100), date });

  const s = await storage.summary(userId, monthKey());
  const saldoBaru = s.totalIn - s.totalOut;
  const icon = type === 'income' ? '💰' : '🧾';
  const label = type === 'income' ? 'Pemasukan' : 'Pengeluaran';
  const lines = [
    `✅ *${label} tercatat!*`,
    '',
    `${icon} ${formatRupiah(found.amount)}`,
    `🏷 Kategori: _${category}_`,
  ];
  if (account) lines.push(`👤 Akun: _${account}_`);
  lines.push(`📝 Catatan: _${note}_`, `#${id} · ${todayLabel()}`, '', `📊 Saldo: *${formatRupiah(saldoBaru)}*`);
  return lines.join('\n');
}

// ---- Grafik batang ----
function barChart(pairs, total, width = 10) {
  return pairs
    .map(([cat, val]) => {
      const pct = total ? Math.round((val / total) * 100) : 0;
      const bars = '█'.repeat(Math.max(1, Math.round((val / (pairs[0]?.[1] || 1)) * width)));
      return `\`${cat.padEnd(10).slice(0, 10)} ${formatRupiah(val).padStart(14)}\`\n${'▎'.padStart(11)} ${'░'.repeat(width - bars.length)}${bars} ${pct}%`;
    })
    .join('\n\n');
}

// ---- Laporan ----
async function handleReport(userId, text) {
  const key = parseMonthFilter(text) || monthKey();
  const [s, pairs] = await Promise.all([
    storage.summary(userId, key),
    storage.breakdown(userId, key),
  ]);
  const inc = s.monthIn;
  const exp = s.monthOut;
  const net = inc - exp;
  const lines = [
    `📈 *LAPORAN ${labelBulan(key)}*${(await storage.isMonthClosed(userId, key)) ? ' 🔒' : ''}`,
    `_${todayLabel()}_`,
    '',
    `💰 Masuk: *${formatRupiah(inc)}*`,
    `🧾 Keluar: *${formatRupiah(exp)}*`,
    `${net >= 0 ? '🟢' : '🔴'} Bersih: *${formatRupiah(net)}*`,
    '',
  ];
  if (pairs.length === 0) {
    lines.push(`_Belum ada pengeluaran di bulan ${labelBulan(key)}._`);
  } else {
    lines.push('*Pengeluaran per kategori:*', '', barChart(pairs, exp));
  }
  return lines.join('\n');
}

// ---- Anggaran ----
async function handleBudget(userId, text) {
  const found = extractAmount(text);

  if (!found) {
    const budgets = await storage.getBudgets(userId);
    const entries = Object.entries(budgets);
    if (entries.length === 0) {
      return [
        '🎯 *Belum ada anggaran.*',
        '',
        'Contoh set anggaran:',
        '_anggaran makan 1jt_',
        '_anggaran transport 500rb_',
      ].join('\n');
    }
    const key = monthKey();
    const spentMap = await storage.monthSpendByCategory(userId, key);
    const lines = [`🎯 *Status anggaran ${labelBulan(key)}:*`, ''];
    for (const [cat, limit] of entries) {
      const spent = spentMap[cat] || 0;
      const pct = limit ? Math.round((spent / limit) * 100) : 0;
      const icon = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢';
      lines.push(`${icon} ${cat}: ${formatRupiah(spent)} / ${formatRupiah(limit)} (${pct}%)`);
    }
    return lines.join('\n');
  }

  // set anggaran: "anggaran <kategori> <nominal>"
  const lower = text.toLowerCase();
  const cat = KATEGORI_PENGELUARAN.find((k) => lower.includes(k)) || 'total';
  await storage.setBudget(userId, cat, found.amount);
  return `🎯 Anggaran *${cat}* diset: *${formatRupiah(found.amount)}* per bulan.`;
}

// ---- Transaksi terakhir ----
async function handleList(userId) {
  const recent = await storage.recentTx(userId, 8);
  if (recent.length === 0) return '📭 Belum ada transaksi. Mulai dengan:\n_out 20rb kopi_';
  const lines = ['🧾 *8 transaksi terakhir:*', ''];
  for (const t of recent) {
    const sign = t.type === 'income' ? '+' : '-';
    const icon = t.type === 'income' ? '💰' : '🧾';
    const tdate = new Date(t.created ?? t.date);
    lines.push(
      `${icon} *${sign}${formatRupiah(Number(t.amount))}* _${t.note}_ (${t.category}${t.account ? ` · ${t.account}` : ''})\n   #${t.id} · ${dayLabel(tdate)} ${timeLabel(tdate)}`
    );
  }
  return lines.join('\n');
}

// ---- Hapus ----
async function handleDelete(userId, text) {
  const idMatch = text.match(/#?(\d+)/);
  if (!idMatch) return '⚠️ Sebutkan ID transaksi.\nContoh: _hapus 3_';
  const id = Number(idMatch[1]);
  // Jangan izinkan penghapusan transaksi di bulan yang sudah ditutup.
  const bulanTx = await storage.txMonth(userId, id);
  if (bulanTx && (await storage.isMonthClosed(userId, bulanTx))) {
    return `🔒 Transaksi #${id} ada di bulan *${labelBulan(bulanTx)}* yang sudah ditutup.\nBuka dulu: _buka ${bulanTx}_`;
  }
  const removed = await storage.deleteTx(userId, id);
  if (!removed) return `❌ Transaksi #${id} tidak ditemukan.`;
  if (removed === true) return `🗑 Transaksi #${id} terhapus.`;
  return `🗑 Terhapus: #${removed.id} ${formatRupiah(removed.amount)} (${removed.note})`;
}

// ---- Saldo ----
async function handleBalance(userId) {
  const key = monthKey();
  const s = await storage.summary(userId, key);
  const net = s.totalIn - s.totalOut;
  const lines = [
    '📊 *RINGKASAN SALDO*',
    '',
    `💵 Saldo total: *${formatRupiah(net)}*`,
    `📅 Bulan ${labelBulan(key)}:`,
    `   Masuk: ${formatRupiah(s.monthIn)}`,
    `   Keluar: ${formatRupiah(s.monthOut)}`,
    `   Bersih: ${formatRupiah(s.monthIn - s.monthOut)}`,
  ];
  lines.push(`🔥 Rata-rata keluar: ${formatRupiah(s.monthOut / new Date().getDate())} / hari`);
  return lines.join('\n');
}

// ---- Akun / dompet ----
// "akun" → daftar semua akun + saldo; "akun bca" → rincian satu akun; "akun baru celengan" → buat akun manual.
async function handleAccounts(userId, text) {
  const arg = text.toLowerCase().replace(/\s+/g, ' ').trim();

  if (arg.startsWith('baru ') || arg.startsWith('tambah ')) {
    const name = arg.replace(/^(?:baru|tambah)\s+/, '').trim();
    if (!name) return '⚠️ Sebutkan namanya.\nContoh: _akun baru celengan_';
    if (/\d/.test(name)) return '⚠️ Nama akun tidak boleh mengandung angka.';
    await storage.addAccount(userId, name);
    return `👤 Akun *${name}* dibuat.\nLangsung pakai: _beli kopi 10rb ${name}_`;
  }

  const balances = await storage.accountBalances(userId);
  const named = balances.filter((b) => b.account);
  const noAccount = balances.find((b) => !b.account);

  if (arg) {
    // rincian satu akun
    const found = named.find((b) => b.account === arg);
    if (!found) {
      const known = await storage.listAccounts(userId);
      if (known.map((k) => k.toLowerCase()).includes(arg)) {
        return `👤 Akun *${arg}* terdaftar tapi belum ada transaksi.\nCatat: _beli kopi ${arg} 10rb_`;
      }
      if (named.length === 0)
        return '👤 *Belum ada akun.*\nAkun otomatis dibuat saat kamu menulis nama akun di transaksi:\n_bayar bakso bca 20rb_';
      return `❌ Akun *${arg}* tidak ditemukan.\nYang ada: ${known.join(', ')}`;
    }
    const lines = [
      `👤 *AKUN ${found.account.toUpperCase()}*`,
      `💵 Saldo: *${formatRupiah(found.balance)}*`,
      '',
      `🧾 *5 transaksi terakhir:*`,
    ];
    const txs = await storage.accountTx(userId, arg, 5);
    for (const t of txs) {
      const sign = t.type === 'income' ? '+' : '-';
      const tdate = new Date(t.created ?? t.date);
      lines.push(`${t.type === 'income' ? '💰' : '🧾'} *${sign}${formatRupiah(Number(t.amount))}* _${t.note}_ · #${t.id} ${dayLabel(tdate)}`);
    }
    return lines.join('\n');
  }

  if (named.length === 0) {
    return [
      '👤 *Belum ada akun.*',
      '',
      'Nama akun cukup ditulis di dalam transaksi:',
      '_uang masuk 5jt dari bca_',
      '_bayar bakso bca 20rb_',
      '_beli kopi gopay 10rb_',
      '',
      'Buat akun manual: _akun baru celengan_',
    ].join('\n');
  }
  const lines = ['👤 *DAFTAR AKUN*', ''];
  for (const b of named) {
    lines.push(`💼 *${b.account}*: ${formatRupiah(b.balance)} · ${b.count} transaksi`);
  }
  if (noAccount) lines.push(`📦 _tanpa akun_: ${formatRupiah(noAccount.balance)} · ${noAccount.count} transaksi`);
  const known = await storage.listAccounts(userId);
  const unused = known.filter((k) => !named.some((b) => b.account === k.toLowerCase()));
  if (unused.length) lines.push('', `_Terdaftar, belum dipakai: ${unused.join(', ')}_`);
  lines.push('', `Total: *${formatRupiah(balances.reduce((a, b) => a + b.balance, 0))}*`);
  lines.push('Rincian: _akun <nama>_');
  return lines.join('\n');
}

// ---- Bantuan ----
function handleHelp() {
  return [
    '💼 *NOOJI BOT KEUANGAN*',
    'Asisten keuangan pribadi via WhatsApp',
    '',
    '*📝 Catat — pakai bahasa bebas*',
    '_uang masuk 10rb gaji bulanan_ → pemasukan',
    '_gaji bulanan 10rb_ → pemasukan',
    '_parkir 2k_ → pengeluaran',
    '_beli bakso dan esteh 20rb_ → pengeluaran',
    '_out 50rb makan siang_ / _in 5jt gaji_ → tetap bisa',
    '',
    '*👤 Multi-akun (bank/e-wallet/tunai)*',
    'Sebutkan akunnya di dalam pesan:',
    '_bayar bakso bca 20rb_',
    '_uang masuk 5jt dari mandiri_',
    '_akun_ → daftar akun & saldo masing-masing',
    '_akun bca_ → rincian akun bca',
    '_akun baru celengan_ → buat akun manual',
    '',
    '*📊 Laporan*',
    '_laporan_ → rekap bulan ini + grafik',
    '_laporan agustus_ → rekap bulan tertentu',
    '_saldo_ → saldo & statistik',
    '_transaksi_ → 8 transaksi terakhir',
    '',
    '*🎯 Anggaran*',
    '_anggaran makan 1jt_ → pasang budget',
    '_anggaran_ → cek status budget',
    '',
    '_hapus <id>_ → hapus transaksi',
    '',
    '*🔐 Tutup buku*',
    '_tutup buku_ → tutup & kunci bulan berjalan',
    '_tutup agustus_ → tutup bulan tertentu',
    '_arsip_ → riwayat bulan yang ditutup',
    '_buka <bulan>_ → buka kembali bulan terkunci',
    '',
    '_menu_ → pesan ini',
    '',
    `Kategori: ${KATEGORI_PENGELUARAN.join(', ')}`,
  ].join('\n');
}

// ---- Tutup buku ----
async function handleCloseBook(userId, text) {
  // "tutup buku" | "tutup buku agustus" | "tutup agustus" — kata "buku" diabaikan.
  const arg = text.toLowerCase().replace(/\bbuku\b/g, ' ').replace(/\s+/g, ' ').trim();
  const key = parseMonthFilter(arg) || monthKey();
  if (key > monthKey()) return `⚠️ Tidak bisa menutup bulan yang belum berjalan (_${labelBulan(key)}_).`;
  if (await storage.isMonthClosed(userId, key))
    return `🔒 Bulan *${labelBulan(key)}* sudah tertutup.\nBuka dulu dengan _buka ${key}_ kalau mau tutup ulang.`;

  let result;
  try {
    result = await storage.closeMonth(userId, key);
  } catch (err) {
    if (err.userMessage) return `⚠️ ${err.userMessage}`;
    throw err;
  }
  const { row, breakdown } = result;
  const lines = [
    `📕 *BULAN ${labelBulan(key)} DITUTUP*`,
    `_${todayLabel()}_`,
    '',
    `💰 Total masuk: ${formatRupiah(row.totalIn)}`,
    `🧾 Total keluar: ${formatRupiah(row.totalOut)}`,
    `${row.net >= 0 ? '🟢' : '🔴'} Selisih: *${formatRupiah(row.net)}*`,
    `📊 ${row.txCount} transaksi · saldo dibawa: *${formatRupiah(row.saldoAkhir)}*`,
  ];
  if (breakdown.length) {
    lines.push('', '*Top 3 pengeluaran:*');
    for (const [cat, val] of breakdown.slice(0, 3)) lines.push(`  ${cat}: ${formatRupiah(val)}`);
  }
  lines.push('', `_Transaksi bulan ini kini terkunci — _hapus_ ditolak._`, 'Lihat lagi kapan saja: _arsip_');
  return lines.join('\n');
}

// ---- Arsip buku yang sudah ditutup ----
async function handleArchive(userId) {
  const list = await storage.getClosed(userId);
  if (list.length === 0)
    return '🗂 *Belum ada buku tertutup.*\nTutup bulan berjalan dengan perintah: _tutup buku_';
  const lines = ['🗂 *ARSIP BUKU TERTUTUP*', ''];
  for (const c of list.slice(-12)) {
    const tgl = new Date(c.closed_at);
    lines.push(
      `🔒 *${labelBulan(c.ym)}* — masuk ${formatShort(c.totalIn)} · keluar ${formatShort(c.totalOut)}\n   net ${c.net >= 0 ? '+' : ''}${formatShort(c.net)} · saldo akhir ${formatRupiah(c.saldoAkhir)} · ${c.txCount} tx · tutup ${dayLabel(tgl)}`
    );
  }
  return lines.join('\n');
}

// ---- Buka kembali bulan (untuk koreksi) ----
async function handleReopenBook(userId, text) {
  const arg = text.toLowerCase().replace(/\bbuku\b/g, ' ').replace(/\s+/g, ' ').trim();
  const key = parseMonthFilter(arg);
  if (!key) return '⚠️ Sebutkan bulannya.\nContoh: _buka buku agustus_ atau _buka 2026-08_';
  const ok = await storage.reopenMonth(userId, key);
  if (!ok) return `❌ Bulan *${labelBulan(key)}* tidak dalam keadaan tertutup.`;
  return `📖 Bulan *${labelBulan(key)}* dibuka kembali.\nTransaksinya bisa diedit/dihapus lagi. Tutup ulang dengan _tutup buku ${key}_`;
}

// ---- Router utama ----
async function processMessage(userId, text) {
  const lower = text.trim().toLowerCase();
  const { cmd, rest } = parseArgs(text);
  const restText = rest.join(' ');

  // Perintah multi-kata didahulukan (mis. "tutup buku agustus").
  if (lower === 'tutup buku' || lower.startsWith('tutup buku ') || matchAlias(cmd, ['tutup']) && !matchAlias(cmd, ALIAS.help))
    return handleCloseBook(userId, lower.replace(/^tutup(\s+buku)?/, '').trim());
  if (lower === 'buka buku' || lower.startsWith('buka buku ') || cmd === 'buka')
    return handleReopenBook(userId, lower.replace(/^buka(\s+buku)?/, '').trim());
  if (matchAlias(cmd, ALIAS.archive)) return handleArchive(userId);

  if (!cmd || matchAlias(cmd, ALIAS.help)) return handleHelp();
  if (matchAlias(cmd, ALIAS.expenses)) return handleTransaction(userId, 'expenses', restText);
  if (matchAlias(cmd, ALIAS.income)) return handleTransaction(userId, 'income', restText);
  if (matchAlias(cmd, ALIAS.report)) return handleReport(userId, restText);
  if (matchAlias(cmd, ALIAS.balance)) return handleBalance(userId);
  if (matchAlias(cmd, ALIAS.list)) return handleList(userId);
  if (matchAlias(cmd, ALIAS.budget)) return handleBudget(userId, restText);
  if (matchAlias(cmd, ALIAS.delete)) return handleDelete(userId, restText);

  // Format bebas: "+ 20rb kopi" / "- 5jt"
  if (cmd === '+') return handleTransaction(userId, 'income', restText);
  if (cmd === '-') return handleTransaction(userId, 'expenses', restText);
  if (matchAlias(cmd, ALIAS.account)) return handleAccounts(userId, restText);

  // Bahasa natural: kalimat biasa yang mengandung nominal + kata arah.
  // "uang masuk 10rb" "gaji bulanan 3jt" "parkir 2k" "beli bakso dan esteh 20rb"
  // Tanpa kata arah pun jalan kalau nomina cocok dengan kategori pengeluaran: "bakso bca 20rb".
  if (extractAmount(text)) {
    let dir = classifyNatural(text);
    if (!dir && guessCategory('expenses', text)) dir = 'expenses';
    if (dir) return handleTransaction(userId, dir, text);
  }

  return [
    `🤔 Perintah tidak dikenali: _${text.slice(0, 40)}_`,
    '',
    'Ketik *menu* untuk melihat daftar perintah.',
  ].join('\n');
}

// ---- Mesin webhook: ekstrak pesan teks dari payload Meta -> balas via WhatsApp ----
async function handleWebhookEvent(body) {
  for (const entry of body.entry || []) {
    for (const change of entry.changes || []) {
      const value = change.value;

      // Update status (delivered/read) — diabaikan diam-diam.
      if (!value?.messages?.length) continue;

      for (const msg of value.messages) {
        if (msg.type !== 'text' || !msg.text?.body) continue;
        const from = msg.from;
        try {
          const reply = await processMessage(from, msg.text.body);
          await sendText(from, reply);
        } catch (err) {
          console.error('[BOT] Error proses pesan dari', from, err);
        }
      }
    }
  }
}

module.exports = { processMessage, handleWebhookEvent };
