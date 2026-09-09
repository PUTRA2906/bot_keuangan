// Lapisan penyimpanan — interface asinkron seragam untuk dua backend:
//   1. PostgreSQL (DATABASE_URL disuntikkan Railway)  -> mode utama di produksi
//   2. File JSON lokal                                -> fallback develop tanpa DB
const fs = require('fs');
const path = require('path');
const { config } = require('./config');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

const usePostgres = Boolean(config.databaseUrl);

// ============================= POSTGRESQL =============================
let pool = null;
let readyPromise = null;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS transactions (
  id       BIGSERIAL PRIMARY KEY,
  user_id  TEXT        NOT NULL,
  type     TEXT        NOT NULL CHECK (type IN ('income','expenses')),
  amount   BIGINT      NOT NULL,
  category TEXT        NOT NULL,
  note     TEXT        NOT NULL DEFAULT '',
  created  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tx_user_date ON transactions (user_id, created);

CREATE TABLE IF NOT EXISTS budgets (
  user_id  TEXT   NOT NULL,
  category TEXT   NOT NULL,
  amount   BIGINT NOT NULL,
  PRIMARY KEY (user_id, category)
);
`;

function pg() {
  if (!pool) {
    const { Pool } = require('pg');
    pool = new Pool({
      connectionString: config.databaseUrl,
      ssl: /localhost|127\.0\.0\.1/.test(config.databaseUrl)
        ? false
        : { rejectUnauthorized: false }, // Railway pakai sertifikat self-signed
    });
    pool.on('error', (err) => console.error('[DB] Error pool:', err.message));
  }
  if (!readyPromise) {
    readyPromise = pool
      .query(SCHEMA)
      .then(() => console.log('[DB] PostgreSQL siap, skema dibuat/diverifikasi.'))
      .catch((err) => {
        readyPromise = null;
        throw err;
      });
  }
  return readyPromise;
}

// pg mengembalikan BIGINT sebagai string; amankan jadi Number.
const num = (v) => Number(v) || 0;

async function addTx(userId, tx) {
  if (usePostgres) {
    await pg();
    const { rows } = await pool.query(
      `INSERT INTO transactions (user_id, type, amount, category, note, created)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [userId, tx.type, tx.amount, tx.category, tx.note, tx.date]
    );
    return rows[0].id;
  }
  const user = getJsonUser(userId);
  user.nextId = (user.nextId || 1) + 1;
  user.transactions.push({ id: user.nextId - 1, ...tx });
  saveJson();
  return user.nextId - 1;
}

async function recentTx(userId, limit = 8) {
  if (usePostgres) {
    await pg();
    const { rows } = await pool.query(
      `SELECT id, type, amount, category, note, created
       FROM transactions WHERE user_id=$1
       ORDER BY id DESC LIMIT $2`,
      [userId, limit]
    );
    return rows;
  }
  return getJsonUser(userId).transactions.slice(-limit).reverse();
}

// Ringkasan saldo total + agregat bulanan dalam 1 query.
async function summary(userId, monthKey) {
  if (usePostgres) {
    await pg();
    const { rows } = await pool.query(
      `SELECT COALESCE(SUM(CASE WHEN type='income' THEN amount END),0)::text  AS total_in,
              COALESCE(SUM(CASE WHEN type='expenses' THEN amount END),0)::text AS total_out,
              COALESCE(SUM(CASE WHEN type='income'   AND date_trunc('month',created)=date_trunc('month',$2::timestamptz) THEN amount END),0)::text AS month_in,
              COALESCE(SUM(CASE WHEN type='expenses' AND date_trunc('month',created)=date_trunc('month',$2::timestamptz) THEN amount END),0)::text AS month_out
       FROM transactions WHERE user_id=$1`,
      [userId, monthKey + '-01']
    );
    const r = rows[0];
    return {
      totalIn: num(r.total_in),
      totalOut: num(r.total_out),
      monthIn: num(r.month_in),
      monthOut: num(r.month_out),
    };
  }
  const txs = getJsonUser(userId).transactions;
  const sum = (pred) => txs.filter(pred).reduce((a, t) => a + t.amount, 0);
  return {
    totalIn: sum((t) => t.type === 'income'),
    totalOut: sum((t) => t.type === 'expenses'),
    monthIn: sum((t) => t.type === 'income' && t.date.startsWith(monthKey)),
    monthOut: sum((t) => t.type === 'expenses' && t.date.startsWith(monthKey)),
  };
}

async function breakdown(userId, monthKey) {
  if (usePostgres) {
    await pg();
    const { rows } = await pool.query(
      `SELECT category, SUM(amount)::text AS total
       FROM transactions
       WHERE user_id=$1 AND type='expenses'
         AND date_trunc('month', created) = date_trunc('month', $2::timestamptz)
       GROUP BY category ORDER BY SUM(amount) DESC`,
      [userId, monthKey + '-01']
    );
    return rows.map((r) => [r.category, num(r.total)]);
  }
  const map = new Map();
  for (const t of getJsonUser(userId).transactions) {
    if (t.type !== 'expenses' || !t.date.startsWith(monthKey)) continue;
    map.set(t.category, (map.get(t.category) || 0) + t.amount);
  }
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

async function getBudgets(userId) {
  if (usePostgres) {
    await pg();
    const { rows } = await pool.query(
      'SELECT category, amount::text FROM budgets WHERE user_id=$1 ORDER BY category',
      [userId]
    );
    return Object.fromEntries(rows.map((r) => [r.category, num(r.amount)]));
  }
  return { ...getJsonUser(userId).budgets };
}

async function setBudget(userId, category, amount) {
  if (usePostgres) {
    await pg();
    await pool.query(
      `INSERT INTO budgets (user_id, category, amount) VALUES ($1,$2,$3)
       ON CONFLICT (user_id, category) DO UPDATE SET amount = EXCLUDED.amount`,
      [userId, category, amount]
    );
    return;
  }
  getJsonUser(userId).budgets[category] = amount;
  saveJson();
}

// Pengeluaran per kategori (untuk baris anggaran) + total pengeluaran bulan ini.
async function monthSpendByCategory(userId, monthKey) {
  const rows = await breakdown(userId, monthKey);
  return Object.fromEntries(rows);
}

async function deleteTx(userId, id) {
  if (usePostgres) {
    await pg();
    const { rowCount } = await pool.query(
      'DELETE FROM transactions WHERE user_id=$1 AND id=$2',
      [userId, id]
    );
    return rowCount > 0;
  }
  const user = getJsonUser(userId);
  const idx = user.transactions.findIndex((t) => t.id === id);
  if (idx === -1) return false;
  const [removed] = user.transactions.splice(idx, 1);
  saveJson();
  return removed;
}

// ---- Fallback JSON lokal ----
let jsonCache = null;

function loadJson() {
  if (jsonCache) return jsonCache;
  try {
    jsonCache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    jsonCache = { users: {} };
  }
  return jsonCache;
}

function getJsonUser(userId) {
  const db = loadJson();
  if (!db.users[userId]) {
    db.users[userId] = { transactions: [], budgets: {}, nextId: 1 };
  }
  const u = db.users[userId];
  u.transactions ??= [];
  u.budgets ??= {};
  u.nextId ??= 1;
  return u;
}

function saveJson() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(jsonCache, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[STORAGE] Gagal menyimpan JSON:', err.message);
  }
}

module.exports = {
  backend: usePostgres ? 'postgres' : 'json',
  addTx,
  recentTx,
  summary,
  breakdown,
  getBudgets,
  setBudget,
  monthSpendByCategory,
  deleteTx,
};
