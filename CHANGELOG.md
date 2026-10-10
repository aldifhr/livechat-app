# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versi mengikuti [semver](https://semver.org/).

## [Unreleased]

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