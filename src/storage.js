// Penyimpanan JSON persisten dengan penulisan atomik (aman terhadap crash).
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');

let cache = null;

function defaultDb() {
  return { users: {} };
}

function load() {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  } catch {
    cache = defaultDb();
  }
  return cache;
}

function save() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2));
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[STORAGE] Gagal menyimpan data:', err.message);
  }
}

function getOrCreateUser(userId) {
  const db = load();
  if (!db.users[userId]) {
    db.users[userId] = { transactions: [], budgets: {}, nextId: 1 };
  }
  const user = db.users[userId];
  user.transactions ??= [];
  user.budgets ??= {};
  user.nextId ??= 1;
  return user;
}

module.exports = { load, save, getOrCreateUser };
