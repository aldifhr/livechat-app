# LiveChat App

Desktop app (Tauri + React) untuk TikTok live chat. Sidecar Node.js (`tiktok-live-connector`) baca websocket TikTok langsung, render di UI.

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
| `POST` | `/api/disconnect` | token | Putuskan |
| `POST` | `/api/rooms/{id}/trigger` | token | Trigger manual (test gift) |
| `POST` | `/api/hooks/{id}` | token | Webhook untuk integrasi luar |
| `GET` | `/api/polls/{id}` | — | Baca poll |
| `GET` | `/api/polls/{id}/vote` | — | Vote (`?choice=N`) |
| `POST` | `/api/polls/{id}` | token | Buat/ganti poll |
| `DELETE` | `/api/polls/{id}` | token | Hapus poll |
| `WS` | `/ws/{client_type}/{id}` | — | Stream event |

### Auth

Semua write butuh header `X-StreamKit-Token` yang cocok dengan `STREAMKIT_TOKEN`,
atau `?token=` di query string (fallback untuk OBS yang tidak bisa kirim header).

**Gate fail closed.** Kalau `STREAMKIT_TOKEN` tidak di-set, setiap write di-refuse
dengan 401 — bukan dibuka. Ini berbeda dari versi sebelumnya yang menerima semua
write saat env kosong, yang membuat deploy yang kehilangan env file jadi API terbuka
padahal lapisan lain terlihat tetap terlindungi. Eksplisitkan mode dev dengan
`STREAMKIT_AUTH_DISABLED=true`, dan backend akan memperingatkan di log saat boot
bahwa semua write terbuka.

Read dan WebSocket tetap terbuka — OBS Browser Source tidak bisa bawa kredensial.

Satu-satunya write yang di-exempt adalah `POST /api/room-connect/{id}`, karena OBS
memuat halaman room tanpa header dan username-nya diambil dari config room yang
tersimpan, bukan dari caller. Dicocokkan per segment path, bukan `startswith`, jadi
route dengan nama lebih panjang tidak mewarisi exemption itu.

### Env

| Nama | Keterangan |
|---|---|
| `STREAMKIT_TOKEN` | Token write. Kosong = semua write 401. |
| `STREAMKIT_AUTH_DISABLED` | `true` = auth dimatikan. Hanya untuk dev. |
| `STREAMKIT_CONFIG_DIR` | Lokasi `rooms.json`. Default `backend/config`. |
