# LiveChat App

Desktop app (Tauri + React) untuk TikTok live chat. Sidecar Node.js (`tiktok-live-connector`) baca websocket TikTok langsung, render di UI.

## Backend (StreamKit)

Backend Python (FastAPI + TikTokLive) untuk overlay OBS. WebSocket real-time, token auth, multi-overlay.

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
| `GET` | `/api/overlays` | — | Daftar overlay |
| `POST` | `/api/overlays` | token | Buat overlay (butuh `name`) |
| `GET` | `/api/overlays/{id}` | — | Detail satu overlay |
| `PATCH` | `/api/overlays/{id}` | token | Ubah `name` / `username` |
| `DELETE` | `/api/overlays/{id}` | token | Hapus overlay |
| `POST` | `/api/overlays/{id}/config` | token | Simpan config |
| `GET` | `/api/overlays/{id}/status` | — | Status koneksi |
| `POST` | `/api/connect` | token | Sambungkan ke room |
| `POST` | `/api/disconnect` | token | Putuskan |
| `POST` | `/api/overlays/{id}/trigger` | token | Trigger manual (test gift) |
| `POST` | `/api/hooks/{id}` | token | Webhook untuk integrasi luar |
| `GET` | `/api/polls/{id}` | — | Baca poll |
| `GET` | `/api/polls/{id}/vote` | — | Vote (`?choice=N`) |
| `POST` | `/api/polls/{id}` | token | Buat/ganti poll |
| `DELETE` | `/api/polls/{id}` | token | Hapus poll |
| `WS` | `/ws/{client_type}/{id}` | — | Stream event |

### Auth

Semua write butuh header `X-StreamKit-Token` yang cocok dengan `STREAMKIT_TOKEN`. Read dan WebSocket tetap terbuka — OBS Browser Source tidak bisa bawa kredensial.

### Env

| Nama | Keterangan |
|---|---|
| `STREAMKIT_TOKEN` | Token write. Kosong = backend terbuka. |
