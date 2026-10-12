# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versi mengikuti [semver](https://semver.org/).

## [Unreleased]

### Security
- **Auth sekarang fail closed.** `token_is_valid` mengembalikan `True` kalau
  `STREAMKIT_TOKEN` tidak di-set, jadi deploy yang kehilangan env file atau salah
  deploy akan melayani setiap write — delete room, rewrite config, post gift palsu —
  ke siapa pun yang menemukan URL, sementara lapisan lain masih terlihat terlindungi.
  Sekarang token kosong berarti **tidak bisa diverifikasi**, bukan tanpa auth.
  - Opt-out eksplisit: `STREAMKIT_AUTH_DISABLED=true` untuk dev.
  - `warn_if_auth_unsatisfiable()` dipanggil di boot, jadi kasus "token hilang" tidak
    lagi terlihat identik dengan "client rusak" dari luar — keduanya cuma 401 tanpa
    penjelasan apa pun.
- **Exemption OBS tidak lagi prefix match.** `startswith("/api/room-connect/")`
  memberi exemption gratis ke route apa pun yang diawali string itu —
  `/api/room-connect-all`, `/api/room-connect/bulk` akan lolos auth tanpa satu
  baris diff pun di baris yang memberikannya. Sekarang `is_exempt_write_path()`
  mencocokkan tepat satu segment, dan test mengunci ketujuh varian path termasuk
  nama yang lebih panjang.

### Fixed
- **Statistik dan leaderboard tercampur antar-room.** `eventlog` menyimpan
  counter, viewer count, dan leaderboard sebagai module global — satu set untuk
  seluruh proses, bukan satu per room.
  - Dua room bisa live bersamaan, dan room kedua yang connect **menghapus**
    counter room pertama (`set_connected` mengosongkan semuanya saat connect).
    Reproduksi: room A punya 2 komentar, B connect → `{'comment': 0}`.
  - Leaderboard jadi gabungan penonton beberapa room, dan handle yang sama di dua
    room terbaca sebagai pengirim berulang — padahal itu orang yang berbeda.
  - State-nya sekarang per-room (`_rooms: dict[str, RoomLog]`); setiap entry point
    menerima `room_id`: `record`, `set_connected`, `is_connected`, `snapshot`,
    `top_chatters`.
  - **Read tidak membuat state.** WebSocket-nya tidak diautentikasi dan room id
    datang dari URL, jadi entry yang dibuat saat read adalah entry yang bisa
    dialokasikan orang asing dengan menebak.
  - Room yang dihapus sekarang `eventlog.forget()` — kalau tidak, room yang sudah
    tidak ada masih menjawab permintaan leaderboard dengan penonton lamanya.
  - Baris log kini menyebut room-nya (`[alpha] comment #1 · …`), karena dengan
    dua room berjalan satu set line log tidak bisa dibaca.
- **Penyimpanan gagal kalau direktori konfigurasi belum ada.** `_flush()`
  memanggil `mkdir(exist_ok=True)`, yang hanya membuat komponen terakhir.
  - `STREAMKIT_CONFIG_DIR=/var/lib/myapp/streamkit/config` pada volume yang
    di-mount kosong gagal dengan `FileNotFoundError` saat write pertama — dan
    itu muncul sebagai 500 pada request yang membuat room, tanpa memberi tahu
    apa pun soal direktori.
  - Sekarang `parents=True`. Default `backend/config` sudah ada, jadi checkout
    tidak berubah apa-apa.
  - Terbukti: dengan `parents=True` dihapus, test baru gagal persis seperti
    laporan (`FileNotFoundError`), dan suite hijau setelah dikembalikan.
- **Dua penonton berbeda yang datang berdekatan jadi satu baris.**
  `SidecarEvent` mendeklarasikan `viewerId` pada varian `join`, sementara host
  Rust mengirim `id` (`backend.rs`, `to_app_event`) — jadi setiap join masuk
  dengan `id` undefined, dan `collapseDecides` yang membandingkan `id` menganggap
  dua orang berbeda itu orang yang sama.
  - Dampaknya nyata dan bukan teoretis: collapse aktif secara default
    (`threshold: 2`, window 2500 ms), jadi penonton kedua **hilang** dan yang
    pertama tampil `x2`. Join termasuk event paling sering di room ramai — 63
    dalam 100 detik pada satu capture.
  - Nama `viewerId` tidak punya asal yang bisa dipertahankan: backend memang
    mengirim event join (`sources/tiktok.py`, handler `JoinEvent`), jadi komentar
    lama yang menyebutnya "dibangun dari chat pertama" sudah salah sejak dulu.
  - `useStats` memang melewati `join`, yang justru menutupi gejalanya —
    leaderboard tidak pernah salah, jadi tidak ada yang pernah melihat.
  - Kedua sisi sebenarnya sudah punya test dan keduanya hijau: test Rust
    meng-assert `join["id"]`, test TS memancarkan `viewerId`. Tiap sisi hanya
    memverifikasi dirinya sendiri dan tidak ada yang melintasi seam-nya.
- **Overlay punya satu salinan, bukan dua.** Halaman yang sama sebelumnya ada di
  `backend/static/` dan `src-tauri/overlay/`, dengan backend menyajikannya lewat
  HTTP dan host meng-embed-nya lewat `include_str!`.
  - Ini sudah bocor sekali: `e315a72` mengubah halaman ini dan meninggalkan
    salinan backend versi lama, jadi OBS menampilkan overlay berbeda dari yang
    app built against, dan tidak ada test yang gagal.
  - Sekarang `src-tauri/overlay/` dihapus dan `overlay.rs` meng-embed file yang
    sama dari `backend/static/`. Backend yang harus berdiri sendiri: ia di-deploy
    ke VPS hanya dengan direktori `backend/`.
  - `test:overlay` sekarang juga gagal kalau salinan kedua muncul lagi.
- **Grammatical residue dari rename `overlay` → `room`.** `sed` mengganti kata tanpa
  menjaga bentuk: `An room id` (main.py), `A scene's own id` (hub.py), plus docstring
  dan label test yang masih menyebut "scene" — sisa dari rename lama StreamKit yang
  tidak ikut. Semua dikembalikan ke "room".
- **7 temuan pyflakes**, semuanya cosmetic dan tidak mengubah perilaku:
  - `main.py` — `import asyncio` dan `from hub import ROOM` tidak terpakai
  - `test_eventlog.py`, `test_watchdog.py` — `import os` tidak terpakai
  - `test_event_fanout.py`, `test_room_connect.py`, `test_viewer_coalesce.py` —
    variabel lokal `loop`, `rr`, `ws` di-assign tapi tidak dibaca
- **Test suite menyiratkan mode auth.** `test_api.py` dan `test_room_connect.py`
  melakukan write tanpa token dan itu bekerja hanya karena gate-nya fail-open. Keduanya
  sekarang menyebut mode yang mereka pakai secara eksplisit, dan ada test baru yang
  membuktikan write tanpa token ditolak.

### Added
- **Test isolasi dua room untuk event log** (`test_eventlog.py`, 52 assertion):
  dua room bicara bersamaan, lalu salah satu disconnect — counter, viewer count,
  repeat, dan leaderboard room lain harus tetap utuh. Termasuk kasus read untuk
  room yang belum pernah ada (harus kosong, dan tidak boleh mengalokasikan entry)
  dan room yang dihapus (harus berhenti memegang leaderboard).
  - Diverifikasi menangkap bug aslinya: 7 dari 9 assertion isolasi gagal kalau
    semua room dipaksa berbagi satu slot, yang persis perilaku lama.
  - Ditambah test end-to-end di `test_api.py` lewat dua socket WebSocket nyata,
    karena leaderboard dijawab per koneksi dari room tempat socket itu berada.
- **Test direktori konfigurasi bertingkat** (`test_store.py`): path config
  bermingk beberapa level yang belum ada, lalu create → update config → reload
  dari disk dengan cache di-drop.
- **`test/test-wire.mjs` — kontrak antara host Rust dan app TypeScript.**
  Producer (`to_app_event` di `backend.rs`) dan consumer (union `SidecarEvent` di
  `sidecar.ts`) dihubungkan oleh apa pun kecuali satu file: yang pertama menulis
  JSON biasa, yang kedua mengklaim bentuknya lewat cast. Tidak ada schema, tidak
  ada codegen, tidak ada tipe yang dibagi — jadi nama field bisa berbeda dan
  tidak ada yang keberatan, karena tiap sisi hanya diperiksa terhadap dirinya
  sendiri.
  - Test ini membaca kedua file dan membandingkannya: setiap field wajib yang
    dideklarasikan harus benar-benar dikirim, dan tiap frame yang diproduksi
    harus punya varian di sisi app.
  - Field opsional ditandai `?` dan tidak diwajibkan dikirim, jadi menambah
    field yang memang belum selalu ada tetap bisa.
  - Terverifikasi menangkap bug aslinya: mengembalikan `viewerId` membuat suite
    gagal dengan 4 kegagalan yang menunjuk tepat ke kedua sisi.
  - `npm run test:wire` disisipkan ke `npm test`.
- Test untuk fail-closed (`test_api.py`): write tanpa token ditolak, `?token=` tidak
  membukanya, read tetap terbuka, dan `STREAMKIT_AUTH_DISABLED` membukanya sambil
  memperingatkan.
- Test untuk exemption path (`test_api.py`): tujuh varian path, termasuk
  `/api/room-connect-admin` yang harus di-gate.

### Known issues (pre-existing, bukan dari audit ini)
- ~~**`npm test` gagal 3 dari suite `test:stats`.**~~ **Tidak bisa direproduksi.**
  Ketiga test yang disebut (`a rising headcount raises the peak with it`,
  `and the current count is added across rooms`, `a falling headcount does not
  lower the peak`) melaporkan peak `11,296`. Sekarang hijau, baik berdiri sendiri
  (`npm run test:stats`) maupun sebagai bagian dari `npm test` penuh.
  Entri lama menduga shared state / jsdom global karena hanya gagal ketika
  `test:ui` berjalan lebih dulu; `src/types.ts` sendiri tidak disentuh di audit
  ini. Akar masalahnya belum ditelusuri, jadi ini dicatat sebagai "tidak bisa
  direproduksi" — bukan sebagai sudah diperbaiki.

## [1.0.0] — 2026-10-10

### Changed
- **Rename `overlay` → `room` di seluruh backend.** Istilah "overlay" bawaan dari repo
  `streamer-kit` dan tidak nyambung dengan `livechat-app`, yang punya konsep *room*.
  304 referensi di 13 file Python, plus nama file test.
  - Route: `/api/overlays` → `/api/rooms`, `/api/overlay-connect/{id}` → `/api/room-connect/{id}`
  - WebSocket client type: `overlay` → `room` (`hub.ROOM`)
  - Field: `overlay_id` → `room_id`, `overlay_clients` → `room_clients`
  - Class: `CreateOverlayRequest` → `CreateRoomRequest`, `UpdateOverlayRequest` → `UpdateRoomRequest`
  - Store: `overlays.json` → `rooms.json`, `all_overlays()` → `all_rooms()`
  - Error message: `"Overlay not found"` → `"Room not found"`
  - Test file: `test_overlay_connect.py` → `test_room_connect.py`,
    `test_overlay_connect_route.py` → `test_room_connect_route.py`,
    `test_overlay_isolation.py` → `test_room_isolation.py`
- **Backend StreamKit dipindahkan ke repo ini** dari `aldifhr/streamer-kit`.
  Vertikal Python yang sebelumnya terpisah sekarang tinggal di `backend/`.
- `.gitignore` — `backend/config/rooms.json` dan `backend/config/overlays.json`
  di-ignore sebagai runtime state, bukan source.

### Added
- **Deploy backend di VPS.** systemd unit `livechat-backend.service`
  (uvicorn, port 8000, `Restart=always`), env di `/etc/streamkit/env`
  (mode 600), domain `kit-backend.aldifhr.my.id` via Caddy dengan
  timeout 900s untuk WebSocket.

### Removed
- **Repo `aldifhr/streamer-kit` dihapus** setelah migrasi. Frontend Next.js
  (`apps/web/`) sudah dihapus lebih dulu; sisanya (FastAPI backend, 11 test
  suite, 3 script debug) pindah ke sini.
- `node_modules/`, `package.json`, `package-lock.json` dari root streamer-kit —
  repo ini sudah punya sendiri.
- 3 script yang salah tempat di `apps/api/tests/` dipindah ke `scripts/`:
  `measure_broadcast.py`, `probe_live_viewers.py`, `validate_live_city.py`.
  Semuanya bukan test, dan `run_all.py` menghitung file `test_*.py` —
  jadi utility yang salah tempat bisa lolos sebagai "suite".

### Breaking
- **`/api/overlays` dan `/api/overlay-connect/*` tidak lagi ada** (404). Client
  harus pakai `/api/rooms` dan `/api/room-connect/*`.
- **Data room lama hilang.** `config/overlays.json` dihapus bersama folder
  `/root/streamer-kit` sebelum rename, jadi tidak ada backup yang bisa dipulihkan.
  Room harus dibuat ulang lewat `POST /api/rooms`. Dua room yang aktif
  (`windyprily`, `akunliverinee`) tidak kembali.

### Notes
- **11/11 test suite hijau** setelah rename — tidak ada assertion yang dilonggarkan
  untuk accommodate perubahan nama.
- Istilah "overlay" masih dipakai di `src/` (React) dan itu benar: di sisi app
  itu memang overlay yang ditampilkan di atas stream, bukan room yang dibaca
  data chat. Yang di-rename hanya domain data backend.

[Unreleased]: https://github.com/aldifhr/livechat-app/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/aldifhr/livechat-app/releases/tag/v1.0.0