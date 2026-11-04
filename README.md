# SISTEM BERBAGI BALIK LAYAR (SBBL)

Starter project frontend + Supabase untuk membangun SBBL dengan desain navy, putih, dan teal yang telah disepakati.

## Isi proyek
- `index.html` — struktur halaman, login Google, dashboard, transaksi, laporan, data sources, scheduled, members, categories, audit log, settings.
- `style.css` — desain responsif.
- `app.js` — interaksi frontend dan koneksi Supabase.
- `config.example.js` — contoh konfigurasi publik Supabase.
- `supabase/schema.sql` — struktur database, RLS, trigger, dan RPC.

## Penting: ini fondasi awal yang perlu dikonfigurasi dan diuji
Jangan langsung menganggap sistem siap dipakai untuk uang sungguhan. Jalankan di proyek Supabase uji dahulu, verifikasi kebijakan RLS, bootstrap Super Admin, alur penonaktifan sesi, dan backup. SQL ini adalah starter, bukan audit keamanan independen.

## 1. Siapkan folder di Mac
1. Ekstrak ZIP ini.
2. Buka folder `SBBL` di VS Code.
3. Duplikasi `config.example.js`, lalu ubah nama salinannya menjadi `config.js`.
4. Isi `SUPABASE_URL` dan `SUPABASE_ANON_KEY` dari Supabase Dashboard → Project Settings → API.
5. Jangan pernah memasukkan `service_role` key ke `config.js`, GitHub, atau frontend.

## 2. Buat proyek Supabase Free
1. Buat akun di https://supabase.com.
2. Buat proyek baru dan simpan database password di password manager.
3. Buka SQL Editor.
4. Jalankan seluruh isi `supabase/schema.sql` pada proyek baru yang masih kosong.
5. Buka Authentication → Providers → Google dan aktifkan Google provider.
6. Buat OAuth Client di Google Cloud Console. Masukkan Client ID dan Client Secret ke konfigurasi provider Google Supabase.
7. Di Supabase Authentication → URL Configuration, masukkan URL lokal saat pengembangan ke Site URL / Redirect URLs (misalnya `http://127.0.0.1:5500/**`) dan nanti tambahkan URL Vercel.
8. Pastikan Google OAuth redirect URI yang diberikan Supabase dimasukkan ke Google Cloud Console.

## 3. Bootstrap Super Admin pertama dengan aman
Jangan biarkan pendaftaran publik memilih role Super Admin.

1. Jalankan website lokal dan login satu kali menggunakan akun Google yang akan menjadi pemilik sistem.
2. Di Supabase Dashboard → Authentication → Users, salin UUID akun tersebut.
3. Di SQL Editor, jalankan perintah berikut dengan mengganti UUID placeholder:
   ```sql
   update public.profiles
   set role='super_admin', status='approved', reviewed_at=now()
   where id='GANTI-DENGAN-UUID-AKUN-PEMILIK';
   ```
4. Pastikan tepat satu akun Super Admin. Jangan membagikan akses Dashboard Supabase atau kredensial pemilik kepada anggota lain.
5. Logout lalu login kembali. Akun pertama kini akan melihat dashboard.

## 4. Jalankan lokal
Gunakan ekstensi Live Server di VS Code:
- Klik kanan `index.html` → Open with Live Server.
- Pastikan URL lokal sudah ditambahkan ke Supabase Auth Redirect URLs.

## 5. Publikasikan ke Vercel
1. Buat repository GitHub privat.
2. Upload file proyek termasuk `config.js` hanya jika berisi URL dan anon/publishable key. Lebih baik simpan nilai konfigurasi melalui Environment Variables Vercel dan buat proses build yang sesuai. Untuk starter statis sederhana, `config.js` dapat berisi hanya URL dan anon key; keduanya memang public client credentials, tetapi RLS wajib aktif.
3. Import repository ke Vercel.
4. Tambahkan domain `*.vercel.app` proyek ke Supabase Auth Redirect URLs dan set Site URL yang sesuai.
5. Pastikan Vercel Hobby hanya dipakai untuk penggunaan personal/nonkomersial sesuai ketentuannya.

## 6. Uji sebelum digunakan
- Pengguna Google baru berstatus `pending` dan tidak dapat membaca transaksi.
- Member yang disetujui dapat membaca, tetapi tidak dapat insert/update/delete transaksi.
- Admin dapat menambah transaksi dan mengelola anggota biasa.
- Admin tidak dapat mengangkat Admin atau mengubah Super Admin.
- Pengguna suspended tidak dapat membaca data lagi pada permintaan berikutnya.
- Pastikan pencabutan sesi Auth dilakukan saat suspend (lihat catatan di bawah).
- Coba akses tabel dan RPC langsung dari browser/devtools dengan akun Member, bukan hanya melalui UI.
- Coba nominal nol/negatif, kategori yang salah, dan transaksi tanggal berbeda.
- Backup data secara manual berkala dan simpan di lokasi aman.

## Catatan keamanan dan pekerjaan lanjutan yang wajib
- Supabase RLS melindungi data setiap request. Frontend menyembunyikan menu hanya untuk UX, bukan keamanan.
- `manage_member` mengubah status profil sehingga request berikutnya ditolak RLS. Untuk memutus sesi aktif seketika, tambahkan Edge Function tepercaya yang menggunakan Admin Auth API untuk sign-out/revoke sesi target. Jangan letakkan service role key di browser.
- SQL starter ini sengaja tidak menyediakan pengangkatan Admin dari UI. Tahap berikutnya adalah RPC Super Admin-only dengan penguncian transaksi untuk memastikan maksimum 4 Admin tambahan secara atomik.
- Belum termasuk edit/void transaksi, unggah bukti transaksi Storage dengan bucket dan policy, backup terjadwal, notifikasi, MFA, rate limiting lanjutan, serta pengelolaan sesi admin. Tambahkan dan uji sebelum produksi.
- `audit_logs` untuk perubahan transaksi/kategori dan tindakan anggota pada starter ini; jangan izinkan pengguna mengubah audit log.
- Frontend hanya memuat 1.000 transaksi terbaru untuk tampilan starter. Untuk laporan jangka panjang, pindahkan agregasi ke SQL views/RPC dan gunakan pagination; jangan mengandalkan data 1.000 baris di browser sebagai laporan final.
- Saldo awal disetel 0. Ubah hanya setelah menetapkan angka kas awal yang benar-benar diverifikasi.
- Untuk uang kelompok sungguhan, siapkan backup independen dan prosedur pemulihan sebelum peluncuran.


## Pembaruan login otomatis (SBBL)

Jika pemilik sistem memilih agar setiap akun Google baru otomatis menjadi anggota aktif, jalankan file `supabase/auto-approve-login.sql` satu kali di **Supabase Dashboard → SQL Editor → New query → Run**. File ini mengganti trigger pembuatan profil agar akun baru berstatus `approved`, mengaktifkan akun member lama yang masih `pending`, serta menerapkan batas role di database: 1 Super Admin, maksimal 4 Admin biasa, dan maksimal 50 anggota. Akun `rejected` atau `suspended` tidak diaktifkan otomatis.

### Konfigurasi redirect Google OAuth

Di Supabase Dashboard buka **Authentication → URL Configuration**. Tambahkan alamat Live Server yang dipakai di browser ke **Redirect URLs**, misalnya:

- `http://localhost:5500/**`
- `http://127.0.0.1:5500/**`

Pastikan Google provider aktif di **Authentication → Sign In / Providers → Google** dan konfigurasi OAuth Client ID/Secret sudah benar. Di Google Cloud OAuth Client, tambahkan origin lokal yang sama pada **Authorized JavaScript origins**. Untuk callback OAuth, gunakan callback URL yang ditampilkan Supabase pada halaman provider Google (jangan menebak atau menggantinya dengan URL localhost).

### Memasang versi kode ini

1. Simpan salinan folder proyek lama sebagai cadangan.
2. Ekstrak ZIP versi terbaru ke folder baru.
3. Salin nilai `SUPABASE_URL` dan `SUPABASE_ANON_KEY` dari `config.js` lama ke `config.js` pada folder baru. Gunakan hanya URL proyek dan publishable/anon key; jangan pernah gunakan `service_role` atau secret key.
4. Jalankan `index.html` dengan Live Server.
5. Jalankan `supabase/auto-approve-login.sql` di SQL Editor Supabase satu kali.
6. Muat ulang halaman, keluar dari sesi lama jika perlu, lalu login Google kembali.

File HTML dan CSS pada paket ini dipertahankan dari starter sebelumnya agar tampilan SBBL tidak berubah. `app.js` diperbarui untuk menangani pemulihan sesi dan callback OAuth secara berurutan, membaca profil dengan percobaan ulang singkat, serta menampilkan pesan error yang lebih jelas.
