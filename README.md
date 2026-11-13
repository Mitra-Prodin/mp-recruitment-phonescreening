# Aplikasi kandidat Phone Screening (Cloudflare Workers)

Halaman yang dibuka kandidat dari link undangan `https://<domain>/s/<token>`. Kandidat menjawab pertanyaan screening di browser HP atau laptop, tanpa login dan tanpa instal.

Aplikasi ini **tidak punya database**. Sumber data tetap web rekrutmen (Laravel):

```
Browser kandidat ──► Worker ini ──► Web rekrutmen  (/api/phone-screening/..., header X-Phone-Screening-Key)
                        │
                        └────────► Bucket R2      (berkas rekaman)
```

Browser hanya memanggil Worker. Kunci `X-Phone-Screening-Key` ditambahkan oleh Worker dan tidak pernah sampai ke browser. Proyek ini berdiri sendiri, terpisah dari repo web rekrutmen. Kontrak API ada di repo `mp-recruitment-backend`, berkas `docs/phone-screening-api.md`.

## Isi folder

| Berkas | Isi |
|---|---|
| `src/index.ts` | Worker: halaman `/s/{token}`, perantara ke web rekrutmen, unggah rekaman ke R2 |
| `src/mock.ts` | Data tiruan yang meniru keempat endpoint web rekrutmen |
| `public/` | Halaman kandidat (HTML, CSS, JavaScript biasa, tanpa proses build) |
| `wrangler.jsonc` | Konfigurasi Worker, binding R2, dan variabel |

## Menjalankan lokal dengan data tiruan

Butuh Node.js 20 atau lebih baru.

```bash
cd mp-phone-screening-app
```

```bash
npm install
```

```bash
cp .dev.vars.example .dev.vars
```

```bash
npx wrangler dev
```

Lalu buka salah satu link berikut. Tidak perlu akun Cloudflare: R2 disimulasikan di komputer lokal (folder `.wrangler/`).

| Link | Isi |
|---|---|
| `http://localhost:8787/s/singkat` | 6 pertanyaan, semua tipe jawaban, boleh kembali, ada jawaban ketik cadangan |
| `http://localhost:8787/s/demo` | 11 pertanyaan bawaan BRD (5 rekaman video), tidak bisa kembali |
| `http://localhost:8787/s/kaku` | Seperti `singkat`, tetapi tidak bisa kembali, tanpa rekam ulang, tanpa jawaban ketik |
| `http://localhost:8787/s/kedaluwarsa` | Link lewat tenggat |
| `http://localhost:8787/s/terkirim` | Link yang jawabannya sudah dikirim |
| `http://localhost:8787/s/ditutup` | Link yang sudah ditutup recruiter |
| token lain | Link tidak ditemukan |

Untuk mengulang dari awal, tambahkan akhiran apa saja: `/s/singkat-2`, `/s/demo-budi`, dan seterusnya. Setiap akhiran adalah undangan baru.

Catatan mode tiruan:

- Data tiruan hidup di memori. Data hilang saat `wrangler dev` dihentikan **atau saat ada berkas yang diubah** (Worker dimuat ulang).
- `http://localhost:8787/api/_mock/<token>` menampilkan jawaban yang tersimpan dan daftar berkas di R2 lokal. Rute ini hanya ada bila `MOCK_API=1`.
- Halaman menampilkan label "Mode tiruan".
- Kamera dan mikrofon hanya bisa dipakai di `localhost` atau HTTPS. Untuk mencoba dari HP, pakai terowongan HTTPS, bukan alamat IP lokal.

Pemeriksaan tipe:

```bash
npm run typecheck
```

## Menjalankan lokal terhadap web rekrutmen sungguhan

Setelah tabel Phone Screening dibuat di web rekrutmen, isi `.dev.vars`:

```
MOCK_API=0
RECRUITMENT_API_URL=http://127.0.0.1:8000
PHONE_SCREENING_API_KEY=<sama dengan PHONE_SCREENING_API_KEY di .env web rekrutmen>
```

## Variabel, secret, dan binding

| Nama | Jenis | Keterangan |
|---|---|---|
| `RECRUITMENT_API_URL` | variabel (`wrangler.jsonc`) | Alamat dasar web rekrutmen, tanpa `/api`. Contoh `https://recruitment.example.com` |
| `PHONE_SCREENING_API_KEY` | **secret** | Kunci bersama. Harus sama dengan `PHONE_SCREENING_API_KEY` di `.env` web rekrutmen |
| `MOCK_API` | variabel | `1` hanya untuk pengembangan lokal. Di produksi harus `0` |
| `MAX_UPLOAD_MB` | variabel | Batas atas satu berkas rekaman, bawaan 60 MB |
| `RECORDINGS` | binding R2 | Bucket rekaman. Harus bucket yang sama dengan `R2_BUCKET` di web rekrutmen |
| `ASSETS` | binding aset | Folder `public/` |

Batas ukuran satu rekaman adalah yang lebih kecil dari `MAX_UPLOAD_MB` dan `durasi maksimal (menit) × 10 MB + 5 MB`. Video direkam sekitar 640×480 dengan bitrate ± 0,6 Mbps, kira-kira 4-5 MB per menit.

Rekaman disimpan dengan kunci `<upload_prefix><question_id>-<retake_count>.<ekstensi>`, misalnya `phone-screening/123/45-1.webm`. Kunci ditentukan oleh Worker, bukan oleh browser.

## Deploy (dijalankan sendiri oleh pemilik)

Belum ada yang dibuat di akun Cloudflare. Langkah berikut membuat resource dan harus dijalankan oleh pemilik akun.

1. Masuk ke akun Cloudflare:

   ```bash
   npx wrangler login
   ```

2. Buat bucket R2 (sekali saja). Nama harus sama dengan `bucket_name` di `wrangler.jsonc` dan `R2_BUCKET` di web rekrutmen:

   ```bash
   npx wrangler r2 bucket create mp-phone-screening
   ```

3. Di `wrangler.jsonc`, isi `RECRUITMENT_API_URL` dengan alamat web rekrutmen dan pastikan `MOCK_API` bernilai `"0"`.

4. Simpan kunci bersama sebagai secret:

   ```bash
   npx wrangler secret put PHONE_SCREENING_API_KEY
   ```

5. Deploy:

   ```bash
   npx wrangler deploy
   ```

6. Pasang domain sendiri (Custom Domain) untuk Worker di dasbor Cloudflare, misalnya `screening.<domain perusahaan>`.

7. Di `.env` web rekrutmen, isi `PHONE_SCREENING_APP_URL` dengan domain itu, `PHONE_SCREENING_API_KEY` dengan kunci yang sama, dan `R2_*` dengan kredensial baca untuk bucket yang sama.

8. Uji dengan satu undangan sungguhan dari HP Android (Chrome) dan iPhone (Safari) sebelum dipakai kandidat.

## Perilaku yang perlu diketahui

- **Format rekaman.** Chrome dan Android merekam WebM (`video/webm`, `audio/webm`). Safari di iPhone merekam MP4 (`video/mp4`, `audio/mp4`). `file_mime` dikirim tanpa keterangan codec. Pemutar di web rekrutmen harus menerima keduanya.
- **Autosave.** Setiap jawaban disimpan ke web rekrutmen saat kandidat berhenti mengetik dan saat pindah pertanyaan. Jawaban yang belum sempat terkirim disimpan sementara di perangkat (localStorage) dan dikirim saat halaman dibuka lagi.
- **Rekaman.** Diunggah di latar belakang dengan coba ulang otomatis. Kandidat boleh lanjut ke pertanyaan berikutnya, tetapi tombol kirim baru aktif setelah semua rekaman terunggah. Rekaman yang belum selesai diunggah hilang bila halaman ditutup, dan kandidat diminta merekam lagi tanpa mengurangi jatah rekam ulang.
- **Batas waktu.** Berlaku pada pertanyaan tertulis bila `use_time_limit` aktif. Saat waktu habis, kandidat dipindahkan ke pertanyaan berikutnya. Pertanyaan wajib yang terlewat dapat dilengkapi dari halaman "Periksa dan kirim" tanpa batas waktu.
- **Halaman tidak dapat dimuat di dalam iframe** (`X-Frame-Options: DENY`), dan token tidak dikirim lewat header Referer.
