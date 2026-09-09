// Mesin utama bot keuangan: routing perintah, pencatatan, laporan, anggaran.
const { extractAmount, formatRupiah } = require('./money');
const { getOrCreateUser, save } = require('./storage');
const { sendText } = require('./whatsapp');

// ---- Domain ----
const KATEGORI_PENGELUARAN = [
  'makan', 'transport', 'belanja', 'tagihan', 'hiburan',
  'kesehatan', 'pendidikan', 'lainnya',
];
const ALIAS = {
  expenses: ['keluar', 'out', 'pengeluaran', 'e', '-'],
  income: ['masuk', 'in', 'pemasukan', 'i', '+'],
  report: ['laporan', 'report', 'r', 'rekap'],
  budget: ['anggaran', 'budget', 'b'],
  balance: ['saldo', 'balance', 's'],
  list: ['transaksi', 'tx', 'list', 'l'],
  delete: ['hapus', 'delete', 'd'],
  help: ['help', 'bantuan', 'menu', 'h'],
  categories: ['kategori', 'kategori'],
  setincome: [] ,
};

function matchAlias(cmd, list) {
  return list.some((a) => cmd === a || cmd.startsWith(`${a} `));
}

function parseArgs(text) {
  const parts = text.trim().split(/\s+/);
  return { cmd: (parts[0] || '').toLowerCase(), rest: parts.slice(1) };
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
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

// ---- Handler transaksi (in/out) ----
// Format: "out 20rb makan siang" atau "out makan 20rb" — nominal & kategori fleksibel posisinya.
function handleTransaction(user, type, text) {
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

  // Kategori: kata pertama setelah nominal yang cocok daftar kategori (atau token lain sebagai catatan).
  const lower = text.toLowerCase();
  let category = 'lainnya';
  if (type === 'income') {
    category = 'gaji';
    const knownCat = ['gaji', 'bonus', 'transfer', 'hadiah', 'investasi', 'lainnya'];
    const hit = knownCat.find((k) => lower.includes(k));
    if (hit) category = hit;
  } else {
    const hit = KATEGORI_PENGELUARAN.find((k) => lower.includes(k));
    if (hit) category = hit;
  }

  // Catatan = teks tanpa nominal dan tanpa kata kategori.
  let note = text
    .replace(found.matched, ' ')
    .replace(new RegExp(`\\b${category}\\b`, 'i'), ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!note) note = category === 'lainnya' ? 'tanpa catatan' : category;

  const tx = {
    id: user.nextId++,
    type,
    amount: found.amount,
    category,
    note: note.slice(0, 100),
    date: new Date().toISOString(),
  };
  user.transactions.push(tx);
  save();

  const icon = type === 'income' ? '💰' : '🧾';
  const label = type === 'income' ? 'Pemasukan' : 'Pengeluaran';
  const saldoBaru = saldo(user);
  return [
    `✅ *${label} tercatat!*`,
    '',
    `${icon} ${formatRupiah(tx.amount)}`,
    `🏷 Kategori: _${tx.category}_`,
    `📝 Catatan: _${tx.note}_`,
    `#${tx.id} · ${todayLabel()}`,
    '',
    `📊 Saldo: *${formatRupiah(saldoBaru)}*`,
  ].join('\n');
}

function saldo(user) {
  return user.transactions.reduce(
    (acc, t) => acc + (t.type === 'income' ? t.amount : -t.amount),
    0
  );
}

// ---- Laporan ----
function totalBulan(user, key) {
  const inc = user.transactions
    .filter((t) => t.type === 'income' && t.date.startsWith(key))
    .reduce((a, t) => a + t.amount, 0);
  const exp = user.transactions
    .filter((t) => t.type === 'expenses' && t.date.startsWith(key))
    .reduce((a, t) => a + t.amount, 0);
  return { inc, exp };
}

function breakdownKategori(user, key) {
  const map = new Map();
  for (const t of user.transactions) {
    if (t.type !== 'expenses' || !t.date.startsWith(key)) continue;
    map.set(t.category, (map.get(t.category) || 0) + t.amount);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function barChart(pairs, total, width = 10) {
  return pairs
    .map(([cat, val]) => {
      const pct = total ? Math.round((val / total) * 100) : 0;
      const bars = '█'.repeat(Math.max(1, Math.round((val / (pairs[0]?.[1] || 1)) * width)));
      return `\`${cat.padEnd(10).slice(0, 10)} ${formatRupiah(val).padStart(14)}\`\n${'▎'.padStart(11)} ${'░'.repeat(width - bars.length)}${bars} ${pct}%`;
    })
    .join('\n\n');
}

function handleReport(user, text) {
  const key = parseMonthFilter(text) || monthKey();
  const { inc, exp } = totalBulan(user, key);
  const net = inc - exp;
  const pairs = breakdownKategori(user, key);
  const lines = [
    `📈 *LAPORAN ${labelBulan(key)}*`,
    `_${todayLabel()}_`,
    '',
    `💰 Masuk: *${formatRupiah(inc)}*`,
    `🧾 Keluar: *${formatRupiah(exp)}*`,
    `${net >= 0 ? '🟢' : '🔴'} Bersih: *${formatRupiah(net)}*`,
    '',
  ];
  if (pairs.length === 0) {
    lines.push('_Belum ada pengeluaran di bulan ini._');
  } else {
    lines.push('*Pengeluaran per kategori:*', '', barChart(pairs, exp));
  }
  return lines.join('\n');
}

const NAMA_BULAN = ['Januari','Februari','Maret','April','Mei','Juni','Juli','Agustus','September','Oktober','November','Desember'];
function labelBulan(key) {
  const [y, m] = key.split('-');
  return `${NAMA_BULAN[Number(m) - 1]} ${y}`;
}
function parseMonthFilter(text) {
  // menerima "2026-09" atau "september" / "9"
  const ym = text.match(/(\d{4})-(\d{1,2})/);
  if (ym) return `${ym[1]}-${String(Number(ym[2])).padStart(2, '0')}`;
  const idx = NAMA_BULAN.findIndex((n) => text.toLowerCase().includes(n.toLowerCase().slice(0, 4)));
  if (idx >= 0) return `${new Date().getFullYear()}-${String(idx + 1).padStart(2, '0')}`;
  return null;
}

// ---- Anggaran ----
function handleBudget(user, text) {
  const lower = text.toLowerCase();
  const found = extractAmount(text);

  if (!found) {
    const entries = Object.entries(user.budgets);
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
    const lines = ['🎯 *Status anggaran bulan ini:*', ''];
    for (const [cat, limit] of entries) {
      const spent = user.transactions
        .filter((t) => t.type === 'expenses' && t.category === cat && t.date.startsWith(key))
        .reduce((a, t) => a + t.amount, 0);
      const pct = limit ? Math.round((spent / limit) * 100) : 0;
      const icon = pct >= 100 ? '🔴' : pct >= 80 ? '🟡' : '🟢';
      lines.push(`${icon} ${cat}: ${formatRupiah(spent)} / ${formatRupiah(limit)} (${pct}%)`);
    }
    return lines.join('\n');
  }

  // set anggaran: "anggaran <kategori> <nominal>"
  const cat = KATEGORI_PENGELUARAN.find((k) => lower.includes(k)) || 'total';
  user.budgets[cat] = found.amount;
  save();
  return `🎯 Anggaran *${cat}* diset: *${formatRupiah(found.amount)}* per bulan.`;
}

// ---- Transaksi terakhir ----
function handleList(user) {
  const recent = user.transactions.slice(-8).reverse();
  if (recent.length === 0) return '📭 Belum ada transaksi. Mulai dengan:\n_out 20rb kopi_';
  const lines = ['🧾 *8 transaksi terakhir:*', ''];
  for (const t of recent) {
    const sign = t.type === 'income' ? '+' : '-';
    const icon = t.type === 'income' ? '💰' : '🧾';
    const tdate = new Date(t.date);
    const tgl = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: '2-digit', month: 'short' }).format(tdate);
    lines.push(
      `${icon} *${sign}${formatRupiah(t.amount)}* _${t.note}_ (${t.category})\n   #${t.id} · ${tgl} ${timeLabel(tdate)}`
    );
  }
  return lines.join('\n');
}

// ---- Hapus ----
function handleDelete(user, text) {
  const idMatch = text.match(/#?(\d+)/);
  if (!idMatch) return '⚠️ Sebutkan ID transaksi.\nContoh: _hapus 3_';
  const id = Number(idMatch[1]);
  const idx = user.transactions.findIndex((t) => t.id === id);
  if (idx === -1) return `❌ Transaksi #${id} tidak ditemukan.`;
  const [removed] = user.transactions.splice(idx, 1);
  save();
  return `🗑 Terhapus: #${removed.id} ${formatRupiah(removed.amount)} (${removed.note})`;
}

// ---- Saldo ----
function handleBalance(user) {
  const key = monthKey();
  const { inc, exp } = totalBulan(user, key);
  const net = saldo(user);
  const lines = [
    '📊 *RINGKASAN SALDO*',
    '',
    `💵 Saldo total: *${formatRupiah(net)}*`,
    `📅 Bulan ${labelBulan(key)}:`,
    `   Masuk: ${formatRupiah(inc)}`,
    `   Keluar: ${formatRupiah(exp)}`,
    `   Bersih: ${formatRupiah(inc - exp)}`,
  ];
  const avgDaily = exp / new Date().getDate();
  lines.push(`🔥 Rata-rata keluar: ${formatRupiah(avgDaily)} / hari`);
  return lines.join('\n');
}

// ---- Bantuan ----
function handleHelp() {
  return [
    '💼 *NOOJI BOT KEUANGAN*',
    'Asisten keuangan pribadi via WhatsApp',
    '',
    '*📝 Catat transaksi*',
    '_out 50rb makan siang_ → catat pengeluaran',
    '_in 5jt gaji bulanan_ → catat pemasukan',
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
    '_menu_ → pesan ini',
    '',
    `Kategori: ${KATEGORI_PENGELUARAN.join(', ')}`,
  ].join('\n');
}

// ---- Router utama ----
function processMessage(userId, text) {
  const user = getOrCreateUser(userId);
  const { cmd, rest } = parseArgs(text);
  const restText = rest.join(' ');

  if (!cmd || matchAlias(cmd, ALIAS.help)) return handleHelp();
  if (matchAlias(cmd, ALIAS.expenses)) return handleTransaction(user, 'expenses', restText);
  if (matchAlias(cmd, ALIAS.income)) return handleTransaction(user, 'income', restText);
  if (matchAlias(cmd, ALIAS.report)) return handleReport(user, restText);
  if (matchAlias(cmd, ALIAS.balance)) return handleBalance(user);
  if (matchAlias(cmd, ALIAS.list)) return handleList(user);
  if (matchAlias(cmd, ALIAS.budget)) return handleBudget(user, restText);
  if (matchAlias(cmd, ALIAS.delete)) return handleDelete(user, restText);

  // Format bebas: "+ 20rb kopi" / "- 5jt" atau teks mengandung nominal di awal?
  if (cmd === '+' || cmd === '-') {
    return handleTransaction(user, cmd === '+' ? 'income' : 'expenses', restText);
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
          const reply = processMessage(from, msg.text.body);
          await sendText(from, reply);
        } catch (err) {
          console.error('[BOT] Error proses pesan dari', from, err);
        }
      }
    }
  }
}

module.exports = { processMessage, handleWebhookEvent };
