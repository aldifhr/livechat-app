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
- Test untuk fail-closed (`test_api.py`): write tanpa token ditolak, `?token=` tidak
  membukanya, read tetap terbuka, dan `STREAMKIT_AUTH_DISABLED` membukanya sambil
  memperingatkan.
- Test untuk exemption path (`test_api.py`): tujuh varian path, termasuk
  `/api/room-connect-admin` yang harus di-gate.

### Known issues (pre-existing, bukan dari audit ini)
- **`npm test` gagal 3 dari suite `test:stats`.** `a rising headcount raises the peak
  with it`, `and the current count is added across rooms`, `a falling headcount does
  not lower the peak` — semuanya melaporkan peak `11,296`. Dikonfirmasi masih gagal
  identik di `6d8376f` (HEAD sebelum audit) dengan nilai yang sama, jadi bukan
  regresi dari perubahan rename. Suite `test:stats` murni frontend
  (`sidecar/test-stats.mjs`) dan tidak menyentuh backend Python, sehingga test ini
  tidak bisa dipengaruhi edit di `backend/`. Jalankan tunggal (`npm run test:stats`)
  hijau — hanya gagal ketika `test:ui` berjalan lebih dulu di proses yang sama,
  curiga shared state / jsdom global. Belum ditelusuri.

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