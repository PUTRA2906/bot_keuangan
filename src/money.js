// Utilitas uang: parsing angka gaya Indonesia (50rb, 1.5jt, 100.000) & format Rp.

const MULTIPLIERS = {
  k: 1e3,
  rb: 1e3,
  ribu: 1e3,
  jt: 1e6,
  juta: 1e6,
  m: 1e6,
  miliar: 1e9,
  mi: 1e9,
};

// Mencari token nominal pertama dalam teks, mis. "out 20rb makan" -> { amount: 20000, ... }
function extractAmount(text) {
  const regex = /(\d[\d.,]*)\s*(rbu|ribu|rb|jt|juta|miliar|k|mi|m)?(?![\w])/i;
  const match = text.match(regex);
  if (!match) return null;

  let numeric = match[1].replace(/\.(?=\d{3}\b)/g, '').replace(/,/g, '.');
  let value = Number(numeric);
  if (!Number.isFinite(value) || value <= 0) return null;

  const unit = (match[2] || '').toLowerCase();
  if (unit) value *= MULTIPLIERS[unit] || 1;

  return { amount: Math.round(value), matched: match[0] };
}

function formatRupiah(value) {
  return new Intl.NumberFormat('id-ID', {
    style: 'currency',
    currency: 'IDR',
    maximumFractionDigits: 0,
  }).format(value);
}

// Angka ringkas: 20000 -> 20rb, 1500000 -> 1,5jt
function formatShort(value) {
  if (Math.abs(value) >= 1e9) return `${(value / 1e9).toLocaleString('id-ID')} M`;
  if (Math.abs(value) >= 1e6) return `${(value / 1e6).toLocaleString('id-ID')} jt`;
  if (Math.abs(value) >= 1e3) return `${(value / 1e3).toLocaleString('id-ID')} rb`;
  return String(value);
}

module.exports = { extractAmount, formatRupiah, formatShort };
