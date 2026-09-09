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
| `DATABASE_URL` | Opsional — koneksi PostgreSQL (di Railway diisi manual sebagai *Reference Variable*) |

## 🚀 Deploy ke Railway

1. Buat project → add service dari repo ini
2. Add **PostgreSQL** dari marketplace Railway
3. Di service bot → tab Variables → tambah `DATABASE_URL` tipe **Reference Variable** yang menunjuk ke variabel `DATABASE_URL` milik service PostgreSQL (mis. `${PostgreSQL.DATABASE_URL}`) — Railway **tidak** menyuntiknya otomatis
4. Isi 4 ENV lainnya, lalu Redeploy — skema tabel (`transactions`, `budgets`, `closed_months`) dibuat otomatis saat startup

Kalau `DATABASE_URL` kosong (misal jalan lokal), bot otomatis fallback ke file `data/db.json`.

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
| Tutup buku | `tutup buku` / `tutup agustus` | Snapshot + kunci bulan |
| Arsip | `arsip` | Daftar bulan yang sudah ditutup |
| Buka buku | `buka agustus` / `buka 2026-08` | Buka kembali bulan terkunci |
| Bantuan | `menu` | Daftar perintah |

### 🔐 Aturan tutup buku

- Bulan yang sudah ditutup **terkunci**: `out`/`in` ditolak, `hapus` transaksi bulan itu ditolak, `laporan` ditandai 🔒.
- Snapshot menyimpan total masuk/keluar, selisih, jumlah transaksi, dan **saldo dibawa** (kumulatif s.d. akhir bulan).
- Salah catat? `buka <bulan>` → edit → `tutup buku <bulan>` lagi.

Kategori pengeluaran: `makan, transport, belanja, tagihan, hiburan, kesehatan, pendidikan, lainnya`

## 🗂 Struktur

```
index.js          # Server Express + webhook
src/
  config.js       # Konfigurasi ENV
  bot.js          # Mesin perintah & balasan
  money.js        # Parser nominal gaya Indonesia
  storage.js      # PostgreSQL (Railway) + fallback JSON (data/db.json)
  whatsapp.js     # Pengiriman pesan via Graph API
```

Data per pengguna disimpan di `data/db.json` (di-gitignore). Tiap nomor WhatsApp punya ledger sendiri.
