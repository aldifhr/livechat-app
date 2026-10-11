# LiveChat App

Desktop app (Tauri + React) untukmonitor TikTok live chat.

App ini **tidak bicara dengan TikTok sendiri**. Ia membaca backend di repo ini
lewat `WS /ws/room/{id}`, lalu menerjemahkan frame-nya ke format yang sama dengan
yang dipakai seluruh UI. Konsekuensinya: tidak ada proses TikTok di PC pengguna,
dan installer tidak lagi membawa executable 85 MB.

> **Tidak ada cadangan.** Kalau backend mati, app tidak bisa membaca chat. Itu
> pilihan, bukan kelalaian — jalankan backend-nya.

## App desktop

```bash
npm install
npm run tauri:dev      # pengembangan
npm run tauri:build    # installer
```

### Test

```bash
npm test                          # typecheck + 6 suite UI
cd src-tauri && cargo test        # 19 test, termasuk mapper frame
```

### Yang perlu diisi di app

`Set up…` di toolbar: alamat backend (`https://…`) dan username streamer. App
mencari room dengan username itu lewat `GET /api/rooms`, lalu menyambungkannya
sendiri — jadi tidak ada UUID yang perlu dibaca dari dashboard.

## Backend (StreamKit)

Backend Python (FastAPI + TikTokLive) untuk live chat room. WebSocket real-time, token auth, multi-room.

```
backend/
├── main.py           # HTTP routes + token guard
├── store.py          # JSON atomic + lock
├── hub.py            # WebSocket hub
├── events.py         # Event types
├── eventlog.py       # Event log
├── watchdog.py       # Liveness watchdog
├── sources/          # TikTokLive source
├── config/           # runtime state (git-ignored)
└── tests/            # 11 test suite
```

### Menjalankan

```bash
python3.12 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
backend/.venv/bin/uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

### Testing

```bash
backend/.venv/bin/python -u backend/tests/run_all.py
```

### Scripts

```bash
backend/.venv/bin/python scripts/measure_broadcast.py
backend/.venv/bin/python scripts/probe_live_viewers.py
backend/.venv/bin/python scripts/validate_live_city.py
```

### API

Semua write butuh `X-StreamKit-Token`. Semua response JSON.

| Method | Endpoint | Auth | Keterangan |
|---|---|---|---|
| `GET` | `/api/rooms` | — | Daftar room |
| `POST` | `/api/rooms` | token | Buat room (butuh `name`) |
| `GET` | `/api/rooms/{id}` | — | Detail satu room |
| `PATCH` | `/api/rooms/{id}` | token | Ubah `name` / `username` |
| `DELETE` | `/api/rooms/{id}` | token | Hapus room |
| `POST` | `/api/rooms/{id}/config` | token | Simpan config |
| `GET` | `/api/rooms/{id}/status` | — | Status koneksi |
| `POST` | `/api/connect` | token | Sambungkan ke room |
| `POST` | `/api/room-connect/{id}` | — | Sambungkan room yang sudah punya username |
| `POST` | `/api/room-connect-by-username` | — | Room dibuat otomatis dari handle |
| `POST` | `/api/disconnect` | token | Putuskan |
| `POST` | `/api/rooms/{id}/trigger` | token | Trigger manual (test gift) |
| `POST` | `/api/hooks/{id}` | token | Webhook untuk integrasi luar |
| `WS` | `/ws/{client_type}/{id}` | — | Stream event |

### Auth

Semua write butuh header `X-StreamKit-Token` yang cocok dengan `STREAMKIT_TOKEN`.

Token **hanya** lewat header. `?token=` di query string sudah dihapus: query string
masuk ke access log, `Referer`, dan riwayat browser, jadi token yang lewat sana
adalah token yang bocor ke mana-mana. Kalau sebuah client tidak bisa kirim header,
itu alasan untuk memakai route yang di-exempt, bukan alasan untuk menambah jalur
kedua.

**Gate fail closed.** Kalau `STREAMKIT_TOKEN` tidak di-set, setiap write di-refuse
dengan 401 — bukan dibuka. Ini berbeda dari versi sebelumnya yang menerima semua
write saat env kosong, yang membuat deploy yang kehilangan env file jadi API terbuka
padahal lapisan lain terlihat tetap terlindungi. Eksplisitkan mode dev dengan
`STREAMKIT_AUTH_DISABLED=true`, dan backend akan memperingatkan di log saat boot
bahwa semua write terbuka.

Read dan WebSocket tetap terbuka — OBS Browser Source tidak bisa bawa kredensial.

Dua write yang di-exempt:

- `POST /api/room-connect/{id}` — username diambil dari config room yang tersimpan,
  bukan dari caller, jadi tidak ada yang bisa dipalsukan.
- `POST /api/room-connect-by-username` — handle adalah satu-satunya yang diminta.
  Route ini membuat room bila belum ada, dan itulah yang dibatasi `AUTO_ROOM_LIMIT`
  (default 20 room auto-created) supaya UNAUTHENTICATED caller tidak bisa
  mengaburkan resource.

Keduanya dicocokkan per segment path, bukan `startswith`, jadi route dengan nama
lebih panjang (`/api/room-connect-admin`) tidak mewarisi exemption itu.

### Env

| Nama | Keterangan |
|---|---|
| `STREAMKIT_TOKEN` | Token write. Kosong = semua write 401. |
| `STREAMKIT_AUTH_DISABLED` | `true` = auth dimatikan. Hanya untuk dev. |
| `STREAMKIT_CONFIG_DIR` | Lokasi `rooms.json`. Default `backend/config`. |
