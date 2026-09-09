# 💼 Nooji — Bot Keuangan WhatsApp

Bot keuangan pribadi berbasis WhatsApp (Meta Cloud API). Catat pengeluaran/pemasukan, lihat laporan bergrafik, atur anggaran bulanan — semuanya lewat chat.

## ⚙️ Konfigurasi (ENV)

Variabel yang dibutuhkan — **sama seperti semula, tidak ada penambahan**:

| Variabel | Fungsi |
|---|---|
| `PORT` | Port server (default `3000`) |
| `WEBHOOK_VERIFY_TOKEN` | Token verifikasi webhook Meta |
| `GRAPH_API_TOKEN` | Access token Meta Graph API |
| `PHONE_NUMBER_ID` | ID nomor WhatsApp Business |

## 🚀 Menjalankan

```bash
npm install
npm start
```

Set endpoint webhook di Meta App ke: `https://domain-kamu.com/webhook`

## 💬 Perintah

| Perintah | Contoh | Hasil |
|---|---|---|
| Catat keluar | `out 50rb makan siang` | Rp 50.000 · kategori makan |
| Catat masuk | `in 5jt gaji` | Rp 5.000.000 · kategori gaji |
| Format singkat | `20rb` `1,5jt` `10.000` | Terdeteksi otomatis |
| Laporan | `laporan` / `laporan agustus` | Rekap + grafik kategori |
| Saldo | `saldo` | Ringkasan & rata-rata harian |
| Transaksi | `transaksi` | 8 transaksi terakhir |
| Anggaran | `anggaran makan 1jt` | Pasang budget bulanan |
| Cek anggaran | `anggaran` | Status 🟢/🟡/🔴 per kategori |
| Hapus | `hapus 3` | Hapus transaksi #3 |
| Bantuan | `menu` | Daftar perintah |

Kategori pengeluaran: `makan, transport, belanja, tagihan, hiburan, kesehatan, pendidikan, lainnya`

## 🗂 Struktur

```
index.js          # Server Express + webhook
src/
  config.js       # Konfigurasi ENV
  bot.js          # Mesin perintah & balasan
  money.js        # Parser nominal gaya Indonesia
  storage.js      # Penyimpanan JSON atomik (data/db.json)
  whatsapp.js     # Pengiriman pesan via Graph API
```

Data per pengguna disimpan di `data/db.json` (di-gitignore). Tiap nomor WhatsApp punya ledger sendiri.
