# StreamKit console — redesign alur, dan style yang tidak lagi hilang

Status: arah sudah disetujui (opsi C) — spec ini menunggu review
Tanggal: 2026-10-14

## Masalah

Alur console terasa ribet. Setelah ditelusuri, penyebabnya bukan layout: **style
overlay tidak pernah disimpan**, dan tidak pernah sampai ke overlay yang sedang
berjalan.

Diverifikasi di setiap lapisan:

| Lapisan | Status |
|---|---|
| `POST /api/rooms/{id}/config` — simpan dan siarkan | **ada** (`backend/routes/rooms.py:123`) |
| `GET /api/rooms` mengembalikan `config` | **ada** (`models.py:135`, `summary()`) |
| Proxy mengizinkan `/rooms/{id}/config` | **ada** (`ALLOWED` di `route.ts`) |
| `resolveStyle(saved)` untuk membaca config tersimpan | **ada** (`shared/overlay.ts:263`) |
| `client.ts` punya cara memanggilnya | **tidak ada** |
| Halaman overlay menangani frame `config` dari WS | **tidak ada** |
| Config tersimpan sampai ke overlay yang berjalan | **tidak** |

Dua lapis terakhir adalah gap-nya, dan keduanya sudah jelas letaknya.

**Halaman overlay membuang frame config.** `socket.onmessage` di
`chat-overlay.html:732` hanya menangani `gift` dan `comment`; yang lain di-*drop*.
Config sebenarnya sudah disiarkan saat overlay terhubung
(`backend/main.py:823` mengirim `{"type":"config",...}`) — jadi frame itu sudah
pernah sampai dan tetap dibuang. `top-chatter.html:396` utamanya hanya
`topChatters`.

**Link yang dipakai tidak pernah membawa config tersimpan.** Backend bisa
memasukkan configroom ke placeholder `__OVERLAY_CONFIG__`
(`backend/main.py:681 _render_overlay`), tapi jalur yang benar-benar dipakai
adalah nginx menyajikan file statis mentah dari `/var/www/streamtools/overlay/`.
Di sana placeholder-nya tidak pernah diganti. Praktisnya, query string
adalah satu-satunya saluran style.

### Akibatnya

- Refresh halaman → seluruh styling hilang, kembali ke default.
- Menggeser slider **tidak mengubah overlay yang sudah jalan di OBS**. Link
  hanya di-*build* saat tombol Copy ditekan; address bar tidak pernah ikut
  berubah.
- Mengubah slider setelah menyalin link membuat link yang sudah ditempel di OBS
  menjadi basi dan harus disalin ulang.

## Arah

Config disimpan, dan overlay menerimanya secara langsung. Streamer menarik
slider, dan yang muncul di layar tontonannya ikut berubah. Sekali satu link
ditempel di OBS, tidak pernah disentuh lagi.

Konsekuensi yang membuat pendekatan ini layak: overlay **tidak** perlu
diperlakukan ulang lewat HTTP. Config datang lewat WebSocket yang sudah terbuka.
Maka keputusan lama "overlay disajikan dari disk supaya tetap hidup saat
dashboard sedang restart" **tetap berlaku** — tidak ada perubahan nginx, tidak
ada routing overlay lewat backend, dan tidak ada credential yang perlu
ditunjukkan OBS.

## Desain

### 1. Style jadi nyata

**`web/src/lib/client.ts`** — ditambah satu cara:

```
saveStyle(roomId, style, kind)  →  POST /rooms/{id}/config
```

`kind` menentukan ruang kunci, karena chat overlay dan top-chatters membaca
fieldset yang berbeda dan tidak boleh saling menimpa.

Nama key yang dikirim adalah nama key **store** (`overlaySize`, dan seterusnya),
bukan nama key query string — supaya tersimpan dalam bentuk yang sudah dibaca
backend.

**`web/src/sections/OverlayBuilder.tsx`**

- Muat style awal dari `room.config` lewat `resolveStyle()`, bukan dari
  `useState(default)`. Urutan: config tersimpan → query string → default.
- Simpan secara **ter-debounce** (400ms) saat style berubah. Menyeret slider
  tidak boleh menghasilkan satu request per pixel.
- Indikator "Tersimpan" / "Menyimpan…", supaya operator tahu hasilnya aman
  alih-alih menebak.

### Bentuk config yang tersimpan — jebakan yang harus diselesaikan lebih dulu

Ada **tiga** konvensi nama key yang berbeda di proyek ini, dan tidak satu pun
sama dengan yang lain:

| Dipakai di | Nama key |
|---|---|
| Store backend (`room.config`) | `overlaySize`, `overlayMax`, `overlayDelay`, `overlayBg`, `overlayNameColour`, `overlayTextColour`, `overlayFont` |
| Query string pada link | `size`, `max`, `delay`, `bg`, `name`, `color`, `font` |
| `resolveStyle(saved)` | `size`, `max`, `delay`, `bg`, `nameColour`, `textColour`, `font` |

`resolveStyle()` dikodekan ke bentuk ketiga, jadi kalau `room.config` langsung
diberikan langsung, **seluruh field kembali ke default secara diam-diam**. Room
`bittersweetbynajla` sudah punya config tersimpan; itulah yang akan hilang.

Karena itu fase 1 tidak boleh dimulai sebelum menambahkan pemetaan di
`shared/overlay.ts`:

```
styleFromStored(config)  →  OverlayStyle
```

memetakan kunci store ke bentuk `OverlayStyle`, lalu menyerahkannya ke
`resolveStyle()` untuk peng-clamp-an. Satu tempat untuk batas dan bentuk,
dapat diuji sendiri, dan tidak ada konversi yang tersebar di komponen.

Penyimpanan baru memakai kunci store, supaya config yang sudah ada tidak perlu
dimigrasi.

> Catatan terpisah: `main.py:49` mendefinisikan `_OVERLAY_STORE_KEYS` sebagai
> salinan dari `models.py:56 OVERLAY_STORE_KEYS`, muncul dari refactor yang
> sedang berjalan dan bukan bagian scope ini. Tahu saja, tidak disentuh.

**`web/public/overlay/chat-overlay.html`** dan **`top-chatter.html`**

Tangani `frame.type === 'config'`: perbarui objek `config` yang sudah ada,
lalu terapkan ulang CSS custom properties. **Tanpa reconnect, tanpa mengosongkan
antrean chat.** Overlay yang sedang berjalan dengan empat puluh komentar di
layar tidak boleh berkedip hanya karena satu slider digeser.

### 2. Stream jadi satuannya

`/admin` berubah dari daftar room menjadi hub. Setiap stream jadi satu kartu
yang membawa semua yang dibutuhkan dalam sekali lihat:

- handle dan label
- badge live — sudah dipolling, sekarang di kartu yang sama
- **kedua link overlay beserta tombol Copy**, terlihat tanpa masuk ke mana pun
- tombol "Style" → editor
- hapus

Link di kartu dibangun dari config tersimpan, jadi yang ditampilkan adalah yang
benar-benar dipakai overlay.

**Empty state** mengajari, bukan sekadar memberi tahu: satu connect → dua style
→ tiga tempel link ke OBS.

### 3. Editor jadi fokus

- Identitas room tampil di atas ("Styling @handle"). Karena datang dari kartu,
  `<select>` untuk memilih room menjadi redundan — tapi switcher ringkas tetap
  ada untuk hop cepat antar stream.
- **Link Copy jadi sticky di atas**, karena itu tindakan akhir. Slider adalah
  caranya; link adalah tujuannya.
- **Preview inline bersebelahan dengan kontrol**, sebesar OBS canvas, diperbarui
  saat slider digeser.
- Dua tab (chat / top chatters) **dipertahankan**. Keputusan lama sudah benar:
  keduanya membaca parameter yang berbeda, dan satu style objek bersama
  menghasilkan slider yang diam-diam tidak bekerja di salah satunya.

### 4. Navigasi

- `Streams`, dengan `?room=` untuk room yang sedang dipilih, dan `Account`
  (About yang digabung).
- Navigasi berbasis URL dipertahankan. Keputusan lama tepat, dan deep-link yang
  bisa dikirim ke orang lain punya nilai nyata.
- Live preview keluar dari menu karena kini inline. Route
  `/admin/live-preview` **tetap hidup** untuk bookmark yang sudah ada.

## Keputusan yang perlu dicatat

**Precedence config.** Config tersimpan adalah sumber kebenaran; query string
adalah fallback untuk room yang belum pernah disimpan. Link yang dihasilkan
sekarang tidak lagi membawa style — cukup `?room=<id>`.

Kalau query string menang, link lama yang membawa style basi akan menimpa setiap
perubahan baru, dan fitur live-update tidak akan pernah terlihat. Link lama yang
sudah tertempel di OBS tetap berfungsi selama room-nya belum disimpan lewat
editor; begitu disimpan, styling-nya kembali dari server.

**Tidak ada perubahan nginx.** Config lewat WS, bukan HTTP.

**Tidak menyentuh backend.** Rutenya sudah ada dan sudah benar.

## Yang tidak berubah

- Batas style di `shared/overlay.ts` — sumber tunggal, dipakai builder dan
  halaman overlay
- Navigasi berbasis URL
- Dua tab overlay terpisah
- Overlay disajikan dari disk, tanpa gate, tanpa credential
- Penulisan atomik `lib/htpasswd.ts`
- Rate limit login

## Pengujian

- `shared/overlay.ts` tidak berubah, dipakai ulang apa adanya.
- **Halaman overlay**: kasus baru untuk frame `config` — diterapkan, dan antrean
  chat yang ada tidak ikut hilang.
- **Editor**: config tersimpan termuat ulang setelah remount. Ini regresi
  "refresh kehilangan styling", dan harus punya test.
- **Debounce**: satu request per jeda tenang, bukan satu per perubahan slider.
- `npm test` dan `tsc --noEmit` tetap hijau. 47 test yang ada tidak boleh terganggu.

## Risiko

- **Overlay berubah bentuk saat config tiba.** CSS custom properties bisa
  diterapkan tanpa flicker, tapi ini perlu dilihat langsung di OBS. Verifikasi
  manual dengan OBS browser source dan cache **dimatikan**.
- **Config lama menimpa.** Room yang sudah punya config dari versi sebelumnya
  mungkin berisi bentuk yang berbeda. `resolveStyle()` sudah meng-clamp setiap
  field, jadi nilai aneh tidak akan merusak halaman — tapi hasilnya tetap perlu
  dilihat.

## Fase

0. **Pemetaan config** — `styleFromStored()` di `shared/overlay.ts`, plus test.
   Prasyarat, bukan fitur tersendiri.
1. **Persistensi** — `client.ts` + editor. Style tidak hilang lagi.
2. **Live push** — halaman overlay menangani frame `config`.
3. **Hub Streams** — kartu, link, empty state.
4. **Editor** — link sticky, preview inline, tab dipertahankan.

Masing-masing berdiri sendiri dan bisa diuji sendiri. Fase 1 saja sudah
menghilangkan kehilangan hasil kerja, jadi kalau mandek di sana, aplikasi tetap
lebih baik dari sekarang.