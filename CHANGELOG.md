# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versi mengikuti [semver](https://semver.org/).

## [Unreleased]

### Removed
- **Desktop app (Tauri) dihapus total.** Seluruh `desktop/` — 166 file: React
  frontend, Rust host (`src-tauri/`), 15 suite `.mjs`, dan 5 script diagnostik.
  Semua fungsinya sudah ada di dashboard web: overlay pages di-serve nginx dari
  disk, giveaway runner jalan di `/admin/streams/@handle/giveaway`, dan docks
  adalah browser source OBS yang sama.
  - **Yang ikut dibuang, dan alasannya:** `test-overlay-page.mjs` (satu-satunya
    suite yang memuat HTML overlay ke DOM asli dan mendorong frame lewat socket —
    bug yang dijaganya adalah *hang*, dan hang tak terlihat oleh regex), dan
    `desktop/scripts/*.py` + `probe-ui.mjs` (probe WebSocket yang bicara ke
    backend, bukan ke app). Diputuskan bersih total, bukan diporting.
  - **`shared/` tetap.** Di-import `web/` lewat alias `@shared` — overlay, events,
    platforms, giveaway.
  - **CI:** job `desktop` dan `rust` dibuang. Sisanya tiga: `api`, `web`, dan
    `shared` (typecheck).
  - **Route `/health/desktop` dihapus.** Ada hanya untuk app desktop yang tidak
    bisa mengirim token, dan route itu terbuka sambil membocorkan handle setiap
    streamer. Tanpa app-nya tidak ada caller yang membutuhkannya.
  - **Origin allowlist Tauri dibuang.** `giveawayOrigin.ts` kini same-origin
    saja; handler `OPTIONS` di route commit dan snapshot dihapus karena tidak ada
    lagi caller cross-origin yang perlu preflight.
  - Komentar dan docstring yang menyebut desktop sebagai consumer aktif
    diperbarui di `api/`, `web/`, `shared/`, `deploy/nginx/`, dan overlay HTML.

### Security
- **Snapshot giveaway: tulis dan daftar kini lewat token, tautan publik tetap terbuka.**
  Dua lubang di route yang sama, dan keduanya karena asumsi "desktop app tidak
  punya kredensial".
  - `POST /api/giveaways/snapshots` dulu **exempt** dari token gate. Padahal app
    desktop sudah publish lewat route dashboard sendiri (`/api/giveaways/snapshots`
    di Next), yang memegang token dan meneruskannya — jadi exemption itu tidak
    melayani satu caller pun yang bekerja. Yang dibelinya: satu write tanpa auth
    langsung ke backend, melewati origin check dan rate limit dashboard (keduanya
    ada di depan backend, jadi bisa diakses dari belakang). Cap-nya 1.000 snapshot
    @ 2 MB, jadi siapa pun yang tahu host bisa mengisinya dan mengunci publish
    sungguhan.
  - `GET /api/giveaways/snapshots` (koleksi) tidak pernah digate sama sekali.
    Dia menjawab dengan **setiap id snapshot** — dan id itu seluruh kredensial untuk
    laporan di belakangnya, yang menyebut TikTok id dan nickname setiap peserta.
    Jadi desain "tautan tak-tertebak" dikalahkan oleh satu route yang membagikan
    id-nya. Sekarang koleksi digate exact-path; baca satu snapshot by id tetap
    terbuka, karena itu yang dipakai tautan yang dibagikan.
  - Ditambah `SENSITIVE_READ_EXACT` di `routes/auth.py` — exact, bukan prefix, supaya
    `/api/giveaways/snapshots/{id}` tidak ikut tergate.
  - Proxy Next: `SENSITIVE_READ` dapat `giveaways/snapshots$`, `PUBLIC_READ` dipersempit
    ke bentuk id saja, supaya daftar membawa token dan by-id tidak.
  - **Setiap write snapshot juga tidak lagi membekukan event loop.** `giveaway_store`
    melakukan I/O file di bawah `threading.Lock`, dan dipanggil langsung dari handler
    `async def` — jadi seluruh `giveaways.json` (sampai 1.000 × 2 MB) diserialisasi
    ulang di loop yang sama sementara WebSocket fan-out menunggu. Kini ada twins
    `_async` yang jalan di worker thread, konvensi yang sudah dipakai `store.py`.
  - 12 assertion baru di `test_api.py` + 4 di `test-proxy-allowlist.mjs`.

- **Backend tidak lagi dijangkau lewat hostname publiknya.** uvicorn bind
  `127.0.0.1:8000` dan nginx ada di box yang sama, tapi nginx mem-proxy ke
  `https://kit-backend.aldifhr.my.id` — setiap frame chat keluar ke router dan
  kembali, dan backend terlihat seperti sesuatu yang *harus* ada di internet.
  Kini `/ws/` dan `= /api/room-connect-by-username` mem-proxy ke loopback, begitu
  pula `BACKEND_URL` default di Next. `BACKEND_ORIGIN` ditambahkan sebagai konstanta
  terpisah untuk origin yang dijangkau **browser** (socket overlay, tautan galeri
  gift) — 127.0.0.1 di browser orang lain adalah mesin mereka sendiri, bukan server
  ini. Default desktop app dan halaman docks ikut pindah ke host dashboard, yang
  sudah mem-proxy kedua route itu — sehingga listener publik backend bisa ditutup.

- **Dua route terbuka overlay dapat plafon per-IP.** `/ws/` tanpa auth dengan
  `room_id` bebas: 40 room id karangan × 5 socket mengisi cap global 200 dan setiap
  overlay sungguhan ditolak dengan 1013 — siaran blank karena orang lain menjalankan
  loop. Kini `limit_conn wsconn 20`. `/api/room-connect-by-username` membuat room
  untuk handle apa pun sampai kuota global 20 auto-room, jadi skrip tidak menghabiskan
  backend tapi menghabiskan *kuota*-nya; kini `limit_req zone=autoroom rate=2r/s`.

- **`/docs`, `/openapi.json` dan `/redoc` mati oleh default.** Ketiganya menjawab
  siapa pun dan memetakan setiap route — termasuk yang dijaga token — lengkap dengan
  bentuk request dan response-nya. Halaman rekognisi gratis di depan API produksi.
  `STREAMKIT_DOCS=true` menyalakannya kembali untuk development.

### Added
- **Favicon untuk dashboard.** Halaman web tidak punya ikon sama sekali: tidak
  ada `public/`, tidak ada `favicon.ico`, dan `metadata` di `layout.tsx` cuma
  menyebut title dan description — jadi tab-nya milik halaman terakhir yang
  pernah dibuka, atau ikon globe generik.
  - Tiga file, semua lewat Next.js file convention di `web/src/app/` supaya
    tidak ada `<link>` yang ditulis tangan dan bisa hilang tanpa jejak:
    `icon.svg` (browser modern), `favicon.ico` (16/32/48, buat request default
    ke `/favicon.ico`), dan `apple-icon.png` (180×180, buat iOS "add to home
    screen" yang tanpa ini cuma screenshot halaman).
  - Warna diambil dari `--bg`/`--accent` di `globals.css` supaya ikon dan header
    produk yang sama. Penuh bleed, bukan tile bersudut transparan: theme terang
    akan memunculkan sudut putih di tab yang gelap — lebih buruk daripada tidak
    ada ikon sama sekali.
  - `favicon.ico` ditulis sebagai DIB 32-bit, bukan PNG-di-dalam-ICO. Yang
    terakhir dibaca sebagian parser dan ditolak yang lain; yang pertama dibaca
    semua, termasuk decoder-nya Next.js sendiri saat build.

- **Overlay OBS sekarang menampilkan gambar gift dan custom emote.** Dua field yang
  backend sudah kirim sejak lama — `giftImage` di `events.py` dan `emotes` di
  `_comment` — dirender oleh app desktop tapi **dibuang** oleh halaman overlay.
  Penonton dapat versi yang lebih jelek dari operator: gift tampil sebagai teks
  `sent Rose x2` tanpa stickernya, dan komentar berisi emote TikTok tampil sebagai
  teks kosong.
  - `renderGift()` membaca `giftImage` dan menggambar `.gift-image`; gift tanpa
    gambar tidak menambah `<img>` kosong, karena gambar rusak lebih buruk daripada
    nama saja.
  - `render()` membaca `emotes` dan menggambar strip `.emotes` di bawah teks.
    TikTok mengirim emote sebagai list di samping pesan, bukan disisipkan ke
    dalam kata-katanya, jadi menaruhnya kembali di posisi asli butuh offset
    karakter yang tidak dibawa wire — strip di bawah adalah bentuk yang jujur.
  - Komentar yang **hanya** berisi emote tidak lagi dibuang: dulu `render()`
    return lebih awal saat teks kosong, yang membuang gambar yang justru seluruh
    isi pesannya.
  - 8 assertion baru di `test-overlay-page.mjs`. Diverifikasi menangkap regresi:
    dengan wiring `giftImage` dikembalikan ke keadaan lama, 2 assertion gagal.

- **Galeri sticker gift akhirnya ada yang menautkan.** `/gifts` sudah di-mount
  sejak sticker-nya diunduh — `StaticFiles` + `gifts.json` 82 KB + 795 `.webp`,
  plus halaman `index.html` yang self-contained dengan search dan sort — tapi
  tidak ada satu pun referensi ke sana di `web/src` atau `desktop/src`, jadi
  satu-satunya cara menemukannya adalah tahu path-nya. Sekarang ada barisnya di
  `/admin/about`, sebagai link karena itu halaman.

- **Kucing di overlay tidur saat streamer offline.** Sebelumnya overlay hanya tahu
  "tidak ada event selama tiga menit" — jadi setelah live berakhir kucing tetap
  jalan-jalan dulu tiga menit, dan untuk status `waiting` (streamer belum live,
  backend tetap polling sampai dua jam) kucing tidak pernah tidur sama sekali.
  Frame `status` yang selama ini sudah dikirim backend — saat socket attach dan
  setiap perubahan state — sekarang dibaca:
  - `connected: false` biasa, `liveEnded`, dan `waiting` langsung menidurkan
    kucing; `connecting` saja tidak, karena itu handshake sepersekon dan
    menidurkannya berarti kucing tumbang setiap reconnect.
  - Selama offline, `upd()` memaksa mode `sleep` sebelum timer idle sempat
    berjalan, dan `wake()`/`boop()`/`react()` menolak membangunkan — event yang
    telat datang tidak boleh menghidupkan kucing di room yang sudah mati.
  - `connected: true` membangunkan kucing dan mengembalikan reaksi event.
  - 11 assertion baru di `test-cat.mjs`, dijalankan lewat socket stub. Diverifikasi
    menangkap regresi: tanpa perubahan halaman, assertion pertama gagal dan
    `offline` tidak terdefinisi.

- **Gift, like, dan follow di overlay kucing sekarang bereaksi berbeda.** Dulu
  ketiganya lewat satu jalur, jadi satu like — interaksi termurah dan paling sering
  — melempar loncatan yang sama dengan gift, dan room yang ramai membuat kucing
  melayang terus-menerus. Sekarang:
  - `like`: hanya puff tiga hati, tanpa loncat dan tanpa mengubah pose. Like
    berdatangan puluhan per detik; satu pose per like berarti kucing tidak pernah
    sempat berdiri.
  - `follow`: tetap `vibe` dengan enam hati.
  - `gift`: tiga tingkat berdasarkan `value` (diamond) — `<100` 6 hati, `≥100`
    10 hati + 4 bintang, `≥1000` 16 hati + 10 bintang. Loncatan ikut tinggi
    (`jumpBoost` 1 / 1.25 / 1.45), dan durasi mode `jump` dihitung ulang supaya
    loncatan yang lebih tinggi tidak terpotong di tengah busur.
  - `jumpBoost` direset oleh mode berikutnya, supaya gift besar tidak membuat
    semua loncatan sesudahnya tinggi.
  - 17 assertion baru. Diverifikasi menangkap regresi: dengan halaman lama,
    6 assertion gagal (like meloncat, 12 hati untuk semua gift, tidak ada bintang,
    `jumpBoost` tidak ada).

### Changed
- **Folder di-rename supaya namanya sesuai perannya: `backend/` → `api/`, `app/` → `desktop/`.**
  `app/` ambigu — `web/` juga sebuah app, dan repo-nya sendiri bernama
  `livechat-app`. `backend/` benar tapi tidak simetris dengan `web/`.
  - Isi dan import internal tidak berubah; yang berubah hanya path: CI
    `working-directory`, `.gitignore`, unit systemd, README, dan komentar yang
    menyebut path lama.
  - `desktop/test/test-voice.mjs` menulis stub ke `dir/app/src/lib` karena
    `rootDir` mengikuti nama folder paket; sekarang `dir/desktop/src/lib`.
  - Artefak `dist/` yang tertinggal di root (bukan output repo ini, dan sudah
    di-ignore) dihapus supaya cerita "root tidak punya build output" tetap benar.

- **`requirements.txt` di-pin, dan satu dependensi yang hilang didaftarkan.**
  Audit menemukan **nol kerentanan** di dependency runtime (12 CVE yang dilaporkan
  semuanya di `pip` sendiri — build tool, bukan yang jalan), jadi ini bukan soal
  versi baru. Ini soal reproducibility:
  - **`python-json-logger` dipakai kode tapi tidak pernah terdaftar.**
    `logging_setup.py` mengimpornya untuk memformat tiap baris log sebagai JSON,
    dan impornya dibungkus `try/except ImportError` — jadi paket yang hilang
    **tidak crash**, dia diam-diam jatuh ke plain text. Tidak ada paket lain yang
    menariknya masuk (dicek reverse-deps: kosong). Artinya venv yang dibangun
    ulang dari `requirements.txt` akan menulis log dengan bentuk berbeda dari
    yang sekarang, tanpa satu pun error.
  - **Floor-nya jauh di bawah kenyataan.** `TikTokLive>=0.8.0` duduk di bawah
    install 7.0.1 — jarak 7 major. Floor yang segitu jauhnya bukan constraint,
    itu komentar: `pip install -r requirements.txt` di mesin baru bisa resolve ke
    versi yang belum pernah diuji siapa pun. Sekarang semua di-pin `==` ke versi
    yang suite-nya hijau.
  - **Diverifikasi dari nol.** Venv baru dibuat hanya dari `requirements.txt`
    yang baru, lalu `tests/run_all.py` dijalankan di dalamnya: **17/17 hijau**.
    Itu pembuktian yang tidak bisa diberikan oleh venv produksi, yang sudah punya
    paket-paketnya.
  - Catatan: **jangan** rebuild venv dengan `python3` default host — itu 3.14,
    sementara venv dan CI sama-sama 3.12. Komentar di `ci.yml` sudah memperingatkan
    hal yang sama.

- **`pythonjsonlogger.jsonlogger` → `pythonjsonlogger.json`.** Path lama masih
  resolve tapi memancarkan `DeprecationWarning` di setiap start sejak 4.0, dan
  file ini jalan sekali per proses — satu warning tiap boot untuk modul yang sudah
  pindah adalah noise di journal. Karena versinya sekarang di-pin, tidak ada
  spelling kedua yang perlu di-fallback; install yang tidak menemukannya jatuh ke
  `except` yang sudah ada dan menulis plain text.

- **`'answer'` dihapus dari `FeedKind`.** Sisa fitur AI yang sudah dihapus di
  `ffbf48e`: `backend/` tidak pernah memproduksinya lagi, tapi `types.ts` masih
  mendeklarasikannya dan `FeedRow.tsx`/`useStats.ts` masih bercabang untuknya.
  Cabang mati seperti itu membuat `FeedKind` berbohong soal apa yang bisa
  datang dari wire. Komentar yang masih menyebut "model" di `useChat.ts` dan
  `useFeed.ts` diperbarui ke auto-reply, satu-satunya penulis baris lokal yang
  tersisa.

- **Volume, language, dan Tester untuk suara.** Tiga setelan yang selalu ada di
  produk lain dan tidak ada sama sekali di sini: suara dari app selalu pada level
  tetap, selalu bahasa Indonesia, dan satu-satunya cara tahu itu benar adalah
  menunggu chat berikutnya datang.
  - **Volume** diterapkan ke elemen `Audio` di halaman, bukan ke sintesisnya —
    tidak ada biaya, dan tidak ada biaya untuk berubah. `clampVolume()` menahan
    nilainya ke 0..1: `Audio.volume` melempar `IndexSizeError` di luar rentang,
    dan lemparan itu dari dalam jalur playback tertangkap sebagai "layanan suara
    tak terjangkau", jadi setelan yang rusak terbaca sebagai layanan yang mati.
  - **Language** dijadi setelan, bukan konstanta. `tl` memang cuma parameter, dan
    satu-satunya hal di layanan ini yang benar-benar memilih suara — jadi bahasa
    adalah pickers suara yang paling jujur yang bisa dimiliki mesin ini, dan bukan
    8 ikonbolt yang tidak melakukan apa-apa.
    - Host punya whitelist sendiri (`speech::LANGUAGES`) dan kode yang tidak dikenal
      jatuh ke default, sama seperti pace — halaman memvalidasi tapi tidak dipercaya.
      Test di kedua sisi mengunci daftar yang sama.
  - **Sample per bahasa.** Tester berbicara dalam bahasa yang sedang diuji, karena
    itu satu-satunya cara tombol itu membuktikan sesuatu. Sample yang terkunci di
    satu bahasa tidak memberi tahu apa pun tentang yang lain.
  - **Tester melaporkan kegagalannya.** `preview()` menolak, tidak menelan — tombol
    yang melaporkan "selesai" sementara tidak ada yang terdengar adalah setelan suara
    yang diam-diam tidak melakukan apa-apa, persis kegagalan yang paling tidak bisa
    didiagnosis. Dia juga mengambil alih suara dan mengabaikan gap: klik yang
    kadang diam-diam tidak terjadi adalah kontrol yang tidak bisa dipercaya.

- **Styling sebuah stream sekarang tersimpan, dan sampai ke overlay yang sedang
  berjalan.** `client.ts` tidak punya cara untuk `POST /api/rooms/{id}/config`,
  jadi tidak ada satu pun kode frontend yang pernah menyimpannya: refresh membuang
  semuanya, dan menggeser slider tidak melakukan apa-apa pada overlay yang sudah
  jalan di OBS.
  - `usePersistedStyle()` memuat style dari `room.config`, menyimpan ter-debounce
    400ms, dan menampilkan "Menyimpan… / Tersimpan / Gagal" supaya hasilnya bukan
    tebakan. Penyimpanan dikendalikan `patch`, bukan `setState`, supaya memuat tidak
    ikut memicu simpan — yang akan menimpa style tersimpan dengan default.
  - `saveStyle()` melakukan **read-modify-write**: `store.set_config` mengganti
    seluruh config, bukan merge, jadi mengirim hanya field yang berubah akan menghapus
    styling overlay yang lain. Kedua tab memang berbagi `size`/`max`/`bg`/warna,
    dan berbeda pada `delay` dan `title`.
  - `styleFromStored()` di `shared/overlay.ts`. Ada **empat** kosakata key yang
    berbeda dan tidak satu pun cocok: store `overlaySize`/`overlayBg`, link
    `size`/`bg`, `resolveStyle()` `size`/`nameColour`, dan halaman `size`/`background`.
    Memberikan `room.config` langsung ke `resolveStyle()` mengembalikan seluruh
    field ke default tanpaclsan apa pun.

### Changed
- **Session 30 hari → 7 hari**, dan jadi configurable lewat
  `STREAMKIT_SESSION_DAYS`. Nilai yang bukan positif (atau `0`, `NaN`, `forever`)
  jatuh ke 7 hari, bukan jadi session selamanya. Hanya berlaku untuk cookie baru —
  token yang sudah terbit masih bawa `exp`-nya sendiri.
- **Baca `htpasswd` di-cache per file.** `passwordHash()` ada di jalur setiap
  request yang digate, dan dipanggil **dua kali**: sekali oleh `auth_request` nginx
  (`/api/auth/verify`) dan sekali lagi oleh `proxy.ts` begitu request-nya sampai di
  app. Itu 2× `readFile` + 2× `stat` per request untuk file yang isinya berubah
  mungkin dua kali setahun.
  - `passwordHashCached()` menahan isi file dan membaca ulang hanya saat
    `(inode, mtime, size)` berubah. Inode ikut karena `setPassword` mengganti file
    dengan `rename` dan hash bcrypt selalu sama panjang — jadi size tidak bisa
    membedakan dua versi, dan pada resolusi mtime 1 detik `mtime` juga tidak.
  - `setPassword()` mengosongkan cache secara eksplisit di `finally`.
  - `verifyPassword()` ikut memakai cache — jalur login juga memungut dua kali.


- **Link overlay sekarang hanya menyebut room.** Dulu ±250 karakter, sebagian besar
  stack font default dalam bentuk URL-encoded, dan dibangun ulang tiap style
  berubah. Benar waktu styling belum punya tempat lain. Sekarang styling-nya ada di
  config room dan overlay diberi tahu lewat socket yang sudah terbuka — link
  ditempel ke OBS sekali, dan setiap restyle berikutnya tidak menyentuhnya.
  - Konsekuensi precedence yang harus disadari: config tersimpan menang atas query
    string. Link lama yang membawa style basi akan mengikuti config room begitu
    room itu pernah disimpan lewat editor.
  - Frame kosong (`{}`) adalah no-op, bukan "balik ke default". Room yang belum
    pernah di-style mengirim `{}`, dan bertindak atas itu akan melucuti styling dari
    link mana pun yang membawa parameternya sendiri. Un-style lewat tombol Reset,
    yang menyimpan default asli.
- **Overlay restyle tanpa reconnect.** `onmessage` hanya mengenal `gift` dan
  `comment`, dan return untuk yang lain — termasuk frame `{"type":"config"}` yang
  sudah dikirim backend sejak socket dibuka. Sekarang di-merge ke config hidup lalu
  custom property diterapkan ulang: tanpa reconnect, tanpa bangun ulang DOM, dan
  tanpa mengganggu komentar yang sedang tampil. Frame adalah style **lengkap**,
  bukan patch, jadi key yang tidak dikirim kembali ke default halaman.
- **`page_config()` di backend**, diteruskan dari `baked_config` dan dipakai juga
  oleh handshake WebSocket dan `emit_config`. Translasi store-key → page-key
  sebelumnya hanya ada di jalur HTML, jadi jalur WebSocket mengirim `overlayBg`
  ke halaman yang mencari `background`: restyle mengubah link tanpa mengubah
  layar. `overlayTitle` masuk peta karena judul board sekarang bisa diatur.
- **`/admin` adalah Streams** — satu kartu per stream, masing-masing membawa kedua
  link overlay beserta tombol Copy. Link yang ditempel ke OBS dulu dua klik masuk
  ke builder yang hanya menampilkan satu room; menyalin link adalah tindakan akhir
  produk ini, jadi ada di kartu. Nama menu Rooms → Streams mengikuti.
- **Preview inline di builder.** Kolom kanan dulu hanya berisi link dan tombol yang
  navigasi pergi. Sekarang berisi overlay sungguhan; slider yang digeser
  mengubahnya tanpa ada yang perlu di-*re-point*. Logika scaling diekstrak ke
  `OverlayStage` dan dipakai bersama halaman live preview, karena dua salinannya
  berarti dua hal yang bisa salah.
- `?title=` sebagai pengganti "overlay mana" diganti `?which=`. `?title=` membaca
  judul board dari query string, dan link sudah tidak membawa satu — jadi ia akan
  diam-diam berhenti memilih board.

### Security
- **Kedua service jalan sebagai `streamkit`, bukan root.** `streamtools-web` dan
  `streamer-api` tadinya `User=root`. Yang web memproxy setiap call mutating dengan
  token yang bisa delete room dan disconnect stream, jadi RCE di sana berarti root
  di seluruh box. Sekarang keduanya `User=streamkit` dengan sandbox yang diperluas
  (`PrivateDevices`, `ProtectKernelTunables/Modules/ControlGroups`,
  `RestrictSUIDSGID`, `RestrictRealtime`, `LockPersonality`). Kode repo tetap
  milik root dan hanya dibaca; yang di-*chown* ke `streamkit` hanya dua hal yang
  memang harus ditulis — password file dan room store.
  - `/etc/streamtools-web.env` dan `/etc/streamkit/env` berubah dari `0600 root:root`
    jadi `0640 root:streamkit`: root tetap pemiliknya, tapi service bisa baca.
  - `/var/lib/streamtools/htpasswd` `0640 root:www-data` → `0600 streamkit:streamkit`.
    Group `www-data` sudah tidak ada gunanya sejak nginx berhenti membaca file itu
    dan beralih ke `/api/auth/verify`.
  - `streamtools-web.service` dihapus dari `After=livechat-backend.service` — unit
    itu tidak pernah ada, jadi urutan startup itu tidak pernah berarti apa-apa.

### Fixed
- **Top Chatters overlay tidak pernah menampilkan apa pun selain contoh dari
  dashboard.** Halaman `top-chatter.html` didesain menarik ranking lewat frame
  `topChatters`, tapi frame itu tidak pernah datang: backend-nya sudah dihapus
  bersama socket protocol lama, lalu halamannya ditambahkan kembali tanpa
  backend-nya. Hasilnya panel tetap tersembunyi selamanya di OBS.
  - `eventlog` kembali menghitung komentar per orang per room (`chatters` /
    `chatter_names`, dikunci pada `user_id` supaya ganti nama tidak memecah satu
    orang jadi dua baris), di-reset saat reconnect, dan di-prune seperti
    leaderboard gifter. Gift tidak ikut, karena board ini soal "siapa yang paling
    banyak bicara".
  - Backend menjawab permintaan `{"type":"topChatters"}` ke **socket yang
    meminta saja**, bukan broadcast: ranking tidak perlu ikut di setiap komentar.
  - Halaman mengirim permintaan itu saat connect dan setiap `poll` detik
    (parameter URL, default 5, 2–60). Sebelumnya halaman hanya menunggu frame
    yang tidak akan datang.
  - 3 assertion baru di `test_api.py` (ranking per room lewat socket asli, room
    sunyi menjawab kosong), 7 di `test_eventlog.py` (urutan, hanya komentar,
    reset, isolasi room), dan 1 di `test-overlay-page.mjs` (halaman benar-benar
    mengirim permintaan saat socket terbuka).

- **Streamer yang tidak live dikenali sebagai "tidak ada yang bisa dibaca", bukan
  kegagalan jaringan.** `UserOfflineError` tidak dikenali di loop retry, jadi
  streamer offline diperlakukan seperti blip jaringan: **10 percobaan, ~2 menit
  backoff** (2s, 4s, 8s … 30s) untuk sesuatu yang sudah pasti sejak detik pertama,
  dengan app menampilkan "Connecting" sepanjang itu — lalu **menyerah permanen**,
  sehingga stream yang datang kemudian tidak pernah diambil.
  - **`_is_offline_error()`** mengenali `UserOfflineError`/`UserNotFoundError`
    lewat class (fallback ke pesan untuk error terbungkus). Offline → **nol retry**,
    langsung masuk `_wait_for_live()` (poll 120 menit) — mesin yang sudah ada untuk
    "live yang berakhir", kini dipakai untuk kedua kasus.
  - **Flag `_offline_waiting`** membuat pesannya jujur: *"is not live — waiting"*,
    bukan *"is no longer live"*. Streamer yang belum mulai tidak "berakhir".
  - **Flag `waiting` di wire**, diteruskan Rust → app. Sebelumnya menunggu 2 jam
    tampil sebagai `connecting`, yang berarti tombol "Connecting…" **disabled** —
    tidak ada cara membatalkan. Sekarang tombolnya **Stop yang bisa ditekan**.
  - **`liveEnded` + `waiting` sekaligus** saat live berakhir lalu ditunggu. Ditemukan
    saat audit produksi: dua room (`@kaizeechiato`, `@rikimaru_u`) sedang poll —
    log bilang *"watching for it, up to 120 minutes"* — tapi endpoint mengirim
    `liveEnded` **tanpa** `waiting`, jadi UI menawarkan Connect untuk room yang
    source-nya masih jalan. `status_payload()` sekarang mengecek `_awaiting_live`
    di cabang live-end, dan app mengecek `waiting` **sebelum** `liveEnded`.
  - **Tes:** 52 assertion di `test_reconnect_budget.py` (offline tidak membakar
    budget, kembali sendiri saat streamer live, status jujur + bisa dibatalkan,
    live-end yang ditunggu tetap bisa dibatalkan, hanya offline yang dibaca begitu)
    + 8 assertion UI. Diverifikasi dengan menyuntikkan perilaku lama: 12 assertion
    gagal, menunjukkan persis bug lamanya (10 attempts, "Gave up connecting").

- **Status basi pada klien yang sudah terhubung.** `source.stop()` adalah teardown
  dan tidak mengirim frame, jadi tiga jalur yang sengaja menghentikan source
  meninggalkan setiap klien dengan status terakhirnya. Paling berdampak untuk
  overlay OBS, yang attach sekali di awal stream dan tidak pernah bertanya lagi:
  diberi tahu "Connected to @someone" lalu tidak ada apa-apa lagi, ia terus
  mengatakannya di atas stream yang sudah berakhir.
  - `/api/disconnect`, ganti username room, dan hapus room kini **broadcast status
    disconnected** setelah stop. Dikirim **setelah** teardown supaya frame tidak
    mendahului dan menggambarkan koneksi yang masih hidup; pada ganti username
    dikirim setelah counter dibuang, supaya frame tidak menghidupkan kembali total
    streamer lama.
  - Tidak broadcast kalau tidak ada source untuk dihentikan — tidak ada yang
    berubah, dan klien yang attach nanti sudah diberi tahu "Offline".
  - **Tes baru `test_disconnect_status.py`** (14 assertion), satu per jalur, plus
    "tidak ada frame saat tidak ada yang berubah".

- **Urutan pesan awal WebSocket bisa tertukar.** `hub.connect()` langsung
  menjalankan writer task, sementara config dan snapshot status dikirim langsung ke
  socket. Event yang di-broadcast di sela itu masuk antrean, diambil writer, dan
  sampai ke klien **sebelum** config yang seharusnya menatanya — overlay yang
  attach ke room ber-style muncul dengan default dan bertahan di sana.
  - Pendaftaran tetap di `connect()`, drain dimulai di **`prime()`** yang dipanggil
    setelah frame pembuka terkirim. Event di sela tetap diantre, tidak hilang.

- **Grafik statistik berhenti disampel saat pindah halaman.** Timer sampel tinggal
  di `useStats`, yang di-mount panel — jadi pindah ke Home dan kembali
  menghentikan sampler selama halaman itu tidak terbuka, dan grafiknya kembali
  dengan lubang di menit yang hilang. Sumbu-x-nya indeks sampel, jadi lubangnya
  bahkan tidak terbaca sebagai lubang: garisnya cuma lanjut, mengklaim datar di
  rentang yang tidak pernah diukur. Timer kini dimiliki recorder
  (`startSampling`/`stopSampling`) dan dijalankan `useChat`, yang hidup sepanjang
  sesi.

- **Panel Stats menyembunyikan data yang sudah masuk.** Kondisinya hanya
  memeriksa viewers atau pesan, jadi sesi yang menerima gift, follow, dan share
  tapi belum ada yang bicara tetap menampilkan "Nothing yet" — panel menyangkal
  event yang sudah ia catat. Sekarang semua yang dihitung ikut menentukan.

- **`count` pada share hilang di batas Rust.** Backend mengirim `meta["count"]`
  (jumlah orang yang bergabung lewat share), mapper Rust tidak meneruskannya. Kini
  diteruskan, dan baris feed menampilkan `· N joined` saat lebih dari satu.

- **Antrean popup tidak dibatasi.** Satu popup tampil 5 detik, jadi burst — gift
  train, tepatnya — datang lebih cepat daripada kemampuan menampilkannya. Tanpa
  batas antreannya tumbuh tanpa henti, dan backlog-nya bukan cuma telat tapi
  **basi**: toast tentang gift dua menit lalu, di atas stream yang sudah lewat.
  Dibatasi 12 (sedikit di atas satu menit); yang terbaru menang.

- **Jendela collapse dihitung dari pesan pertama.** Saat baris digabung,
  timestamp-nya tidak diperbarui, jadi jendelanya diukur dari *awal* rentetan:
  penonton yang mengulang pesan sama tiap 2 detik bergabung selama 2,5 detik lalu
  berhenti, meski setiap pesan masih di dalam jendela pesan sebelumnya. Timestamp
  kini maju ke kemunculan terbaru — barisnya tetap mempertahankan key, hanya waktu
  yang diwakilinya yang bergerak.

- **Tes flaky `test:ui` diperbaiki.** Menunggu debounce 250ms tanpa `act()` di
  tes digit `RollingNumber`, sehingga React belum tentu flush sebelum snapshot
  "sebelum" diambil — kadang terbaca 1 strip, bukan 4, dan perbandingan digitnya
  gagal karena alasan yang tidak ada hubungannya dengan digit. Dibungkus `act()`
  plus satu `flush()`. Diverifikasi 6× berturut-turut hijau.

- **Status koneksi pulih setelah frontend di-reload saat development.** `tauri:dev`
  memuat ulang webview setiap kali kode berubah. Reload itu membuang seluruh
  state frontend, sementara proses Rust **tetap membaca stream** — dan itu memang
  disengaja, sama seperti koneksi yang bertahan saat window disembunyikan ke tray.
  Halaman baru karenanya mulai dari room idle: tombolnya bilang Connect dan
  badge-nya "Not connected" **sementara baris chat masih masuk**, karena tidak ada
  yang pernah menghentikan reader.
  - **Host sekarang menyimpan snapshot sesi, bukan cuma penghitung generation.**
    `BackendState` mencatat handle, room id, judul, dan viewers terakhir; plus
    `running` yang membedakan "sedang membaca" dari "sudah menyerah setelah retry
    habis". `snapshot()` merangkainya jadi satu frame `status` bertanda
    `snapshot: true`.
  - **Perintah baru `backend_status`.** Host tidak punya cara tahu webview
    di-reload — Tauri membuat ulang halaman tanpa memberi tahu sisi Rust — jadi
    tidak ada momen untuk push. Bertanya adalah satu-satunya sinyal yang andal.
  - **`useChat` bertanya sekali saat mount**, setelah listener terpasang supaya
    tidak kalah balapan dengan frame yang datang di tick yang sama. Jawabannya
    diadopsi lewat `adoptSnapshot()`, jalur yang sama dengan frame asli: guard-nya
    ikut belajar `session` yang sedang berjalan, sehingga straggler dari sesi lama
    tetap ditolak setelah reload. Snapshot **tidak** ditulis ke log — tidak ada
    yang terjadi, halaman cuma lupa — supaya tidak muncul baris "Connected to @x"
    yang tidak pernah ada.
  - **Bukan reconnect.** Menyambung ulang akan membuka socket kedua untuk room
    yang sudah dibaca, dan stempel sesi justru akan menolak setiap frame dari
    reader yang benar-benar berjalan.
  - **Field handle ikut dipulihkan dari `room.target`.** Dulu hanya di-seed dari
    config tersimpan, jadi setelah reload — dengan config kosong tapi stream
    jalan — fieldnya kosong di samping tombol Stop, dan catatan di sebelahnya
    menyebut room yang handle-nya tidak ada di layar.
  - **Tes baru `test/test-reload.mjs`** (14 assertion): reload memulihkan status,
    handle, dan viewers; frame dari sesi yang dipulihkan terbaca; straggler sesi
    lama **ditolak** (diuji dengan urutan yang benar-benar menguji adopsi sesi —
    straggler dikirim sebelum frame sesi baru); reload setelah Stop kembali idle;
    host tanpa jawaban tidak meninggalkan state setengah. Ditambah 4 tes Rust.

- **Stop berhenti di UI tapi event chat tetap masuk.** Setelah menekan Stop, badge
  sudah bilang "Not connected" sementara baris chat baru terus muncul. Ini bukan
  bug kosmetik: sumbernya memang masih menyalurkan, dan UI-nya tidak punya cara
  membedakan frame dari sesi yang sudah ditutup.
  - **`backend_disconnect` meng-emit dulu, baru `stop()`.** Urutannya terbalik:
    frame yang di-emit beberapa mikrodetik sebelum Stop sudah masuk antrean
    Tauri, jadi mendarat **setelah** konfirmasi "Disconnected" — dan di bawah
    badge yang sudah bilang berhenti. Sekarang `stop()` menaikkan generation
    lebih dulu, baru status di-emit.
  - **`pump()` tidak memeriksa generation setelah `resolve_and_start()`.** Resolve
    itu POST dengan timeout 20 detik, jadi Stop yang ditekan saat Connect masih
    berjalan akan dilewati: loop-nya lanjut membuka socket dan mengumumkan room —
    persis "Stop bilang berhenti, lalu tetap connect". Sekarang dicek lagi tepat
    setelah resolve, dan juga sebelum backoff pada percobaan yang gagal.
  - **Frontend tidak punya konsep sesi.** Host sekarang menstempel setiap frame
    yang diproduksi reader dengan generation-nya (`with_session`), dan `sidecar.ts`
    menjatuhkan frame dari sesi yang sudah ditutup **di titik masuk frame** —
    sebelum feed, counter, status line, atau hook alert mana pun melihatnya.
    Ditaruh di sana, bukan di `useChat`, karena feed bukan satu-satunya pembaca:
    suara gift, mention yang diucapkan, dan auto-reply membaca frame yang sama,
    dan sesi yang sudah berhenti tidak boleh membunyikan bel atau menjawab sapaan.
  - **Frame tanpa stempel tidak pernah digerbang** — itu frame host tentang reader
    itu sendiri, termasuk konfirmasi Stop, yang justru harus lolos setelah sesi
    yang ditutupnya sudah dijatuhkan.
  - **Stop menutup sesi saat diklik**, bukan saat dikonfirmasi, jadi feed berhenti
    bersamaan dengan tombolnya. Konfirmasi host menutupnya juga, supaya jaminannya
    tidak bergantung pada klik sebagai pemicunya.
  - Sesi yang lebih baru **diadopsi**, bukan ditolak, jadi Connect setelah Stop
    langsung jalan tanpa ada yang perlu membuka gerbang lagi; dan straggler dari
    sesi lama tetap dijatuhkan meski sesi baru sudah terbuka.
  - **Sumbernya benar-benar berhenti**, bukan disembunyikan: reader memeriksa
    generation sebelum dan sesudah setiap tunggu lalu menutup socket, dan `pump`
    tidak mencoba ulang. Gerbang di frontend hanya untuk frame yang sudah telanjur
    dalam perjalanan — jendela yang tidak bisa ditutup host sendirian, karena
    `emit` menyerahkan frame ke webview lalu langsung kembali.
  - **3 tes Rust baru** (61 total) untuk stempel sesi, staleness setelah Stop, dan
    Stop yang mendarat saat resolve masih in-flight. **8 assertion UI baru** di
    `test-ui.mjs` menutupi baris/event count/viewer/status yang basi, adopsi sesi
    baru, dan straggler yang datang terlambat. Diverifikasi menangkap bug aslinya:
    dengan gerbang sesi dimatikan, 5 assertion gagal — termasuk
    `stale connected999 watching`, yang persis gejalanya.

- **Live yang berakhir membuat source mati permanen, jadi "offline" padahal live.**
  Dilaporkan langsung: `@bittersweetbynajla` dibilang offline padahal sedang live.
  Dicek ke TikTok: `liveRoom.status=2`, judul `FLASH SALE 1000🔥😱🥳 (UNII)`.
  - **Penyebabnya `_live_ended` bersifat terminal.** Kondisi loop-nya
    `while self._running and not self._live_ended`, jadi begitu satu live berakhir
    source-nya keluar dan tidak ada yang membangkitkannya selain Connect manual.
    Komentar di kode bahkan menyatakannya sebagai desain: *"nothing reconnects
    after it"*. Padahal berhenti lalu mulai lagi beberapa menit kemudian itu biasa.
  - **Socket lama tidak bisa dipakai ulang** — dan ini bagian yang membuat
    perbaikannya harus berupa poll, bukan reconnect. Live baru dapat room id baru;
    terukur: `7696774047573838612` berakhir, `7696866940727397126` mulai. Tidak ada
    yang bisa di-reconnect, jadi satu-satunya cara tahu adalah bertanya.
  - Loop sekarang punya **loop luar**: satu putaran = satu sesi. Live yang berakhir
    masuk ke `_wait_for_live()` yang menanyakan `is_live()` tiap 60 detik, sampai
    **120 kali (2 jam)**. Kalau streamer kembali, flag dibersihkan lalu loop luar
    membuka sesi baru. Kalau tidak, source menyerah — dan pada titik itu "live
    berakhir" memang benar.
  - **Batasnya dihitung, bukan diukur jam.** Budget `time.monotonic()` tidak maju
    saat tes memperpendek `sleep`, jadi loop-nya berputar tanpa pernah kedaluwarsa
    — itu benar-benar terjadi saat dikerjakan: `test_reconnect_budget.py`
    menggantung sampai timeout. Menghitung poll juga lebih jujur soal apa yang
    dibatasi ("berapa request yang mau dibelanjakan").
  - **Stop berarti stop.** `disconnect()` menyalakan `_stopping`, jadi menekan Stop
    saat menunggu berhenti saat itu juga, bukan menunggu sampai satu menit tick
    berikutnya. `connect()` membersihkannya lagi, kalau tidak source yang
    di-stop-lalu-start akan mewarisi Stop lama dan menolak menunggu.
  - Probe yang gagal **bukan** berarti "streamer tidak kembali": satu request jelek
    di-log di DEBUG dan ditanya lagi, bukan mengakhiri penantian.
  - **18 assertion baru** di `tests/test_live_return.py`, seluruhnya menggerakkan
    `TikTokAdapter` asli dengan hanya client dan clock yang diganti. Diverifikasi
    menangkap bug aslinya: dengan penantian dikembalikan ke perilaku lama, 2
    assertion gagal (`the loop opened a second session`, `and it asked TikTok`).
  - Suite backend sekarang **18/18**.

- **Tiga suite merah, dan tiga-tiganya soal salinan kedua dari satu angka.**
  `aefaa72` ("fix: 6 bugs from audit") mengubah perilaku di tiga tempat dan
  meninggalkan tes yang mengunci perilaku lama, jadi CI merah di commit itu dan
  di tiga commit sebelumnya.
  - **Cap feed: 500 di tes, 200 di app.** `f58c150` menurunkan `MAX_ITEMS`
    500→200 dan tidak menyentuh `test-ui.mjs`, yang masih menulis `<= 500` dan
    menghitung urutan dari `msg 100`. Tes sekarang membaca `MAX_ITEMS` dari app
    lewat `ui-entry.ts` — angka yang di-hardcode di tes adalah salinan kedua, dan
    itulah persis yang membuat suite tetap merah atas angka yang app-nya benar.
  - **Counter eventlog dihapus saat disconnect.** "Bug 4" di `aefaa72` memanggil
    `room.reset()` di cabang `connected=False`, padahal docstring modul dan
    `test_eventlog.py` (dari `e65c9f4`) menginginkan counter **bertahan** sampai
    room connect lagi: `B still reports what it sent before it dropped`. Reset
    tetap di jalur connect saja — reconnect adalah sesi baru, disconnect bukan.
  - **Halaman overlay melenceng, dan yang diluruskan justru sisi yang salah.**
    "Bug 7" memperbaiki `backend/static/topchatter.html` ke 36px/0.9 tanpa
    menyentuh `web/public/overlay/top-chatter.html` (28px/0.35) — padahal
    `test-overlay-sync.mjs` menyebut `web/public` sebagai salinan kanonik. Dan
    "Bug 6" menulis ulang `var over` di `backend/static/overlay.html` sementara
    `web/public` dibiarkan. Kedua pasangan kini identik, ke arah nilai yang
    sudah disepakati `shared/overlay.ts` (`size: 36`, `bg: 0.9`).
  - Diverifikasi: backend 17/17 suite, app 808 assertion, web hijau.

- **Dua halaman tidak sepakat dengan dirinya sendiri soal "tanpa styling".**
  `STYLE_DEFAULTS` adalah yang di-reset sebelum style hasil push diterapkan,
  jadi itu jawaban halaman atas "seperti apa overlay tanpa style". Literal
  `config` di baris-baris sebelumnya adalah jawaban yang sama, untuk load. Dua
  salinan dari satu konsep di satu file — dan keduanya sudah melenceng, di dua
  halaman, ke arah yang berbeda.
  - **Chat: `background` 0 saat load, 0.05 saat reset.** Jadi overlay terbuka
    dengan video tembus lurus, lalu dapat scrim samar begitu backend push style
    untuk room yang config tersimpannya tidak punya `bg`. Tiga sumber sudah
    bilang 0 — `shared/overlay.ts`, default load, dan komentarnya — jadi yang ini
    outlier-nya.
  - **Board: `size` 36 saat load, 28 saat reset.** Ini regresi yang `25151ca`
    ditulis untuk tutup, kembali lewat jalur yang fix itu tidak sentuh. Commit itu
    menaikkan default load dan `shared/overlay.ts`, dan check yang ditambahkan
    membandingkan keduanya — jadi salinan ketiga tidak pernah masuk scope dan
    tidak pernah naik. Board terbuka di 36px, 1.9% dari canvas 1920px, turun ke
    28px, 1.5%, begitu backend push style untuk room tanpa `size` tersimpan.
    Ukuran yang sama, tidak terbaca lagi, di hari yang sama dengan fix-nya.
  - `test-overlay-sync.mjs` sekarang membandingkan tiap halaman terhadap default
    load-nya sendiri, bukan hanya terhadap shared module. Membandingkan hanya
    terhadap `shared/` tidak bisa melihat kelas bug ini sama sekali: tiap salinan
    masih cocok dengan shared module — itulah sebabnya check lama tetap hijau.

- **Jalur restyle langsung tidak punya test sama sekali.** Frame `config` adalah
  hal terbaru di wire dan paling sedikit terlindungi, dan juga paling
  berdampak: itu cara streamer menata stream yang sedang jalan, lewat link yang
  ditempel ke OBS sekali lalu tidak pernah disentuh. Bug di sini tidak error —
  halaman render, OBS render, overlay cuma menampilkan hal yang salah, dan itu
  baru ketahuan dengan melihat live.
  - 27 assertion menjalankan halaman sungguhan di JSDOM dengan frame didorong lewat
    socket palsu: push sampai ke custom property; key yang tidak dibawa frame
    revert, bukan menetap (frame adalah style **penuh**, bukan patch); baris chat
    yang sudah tampil tetap objek baris yang **sama** dan tidak ada socket kedua
    yang dibuka; komentar setelah restyle tetap sampai, karena `config.username`
    adalah yang dipakai render dan merge yang salah akan menghasilkan overlay
    yang styled tapi bisu; `{}` adalah no-op termasuk pada link yang membawa `bg`
    sendiri; `null` dilewati, bukan ditulis sebagai `--name-colour: null`; dan
    `max` yang dipush benar-benar mengubah limit yang ditegakkan.
  - Default pembandingnya dibaca dari halaman, bukan ditulis di test. Literal di
    test adalah salinan kedua dari angka yang sama — persis bagaimana size board
    berakhir 36 di satu tempat dan 28 di tempat lain dengan semua assertion hijau.

- **Daftar bahasa bisa melenceng tanpa apa-apanya terjadi.** `TTS_LANGUAGES` di
  `voices.ts` adalah yang ditawar picker, `speech::LANGUAGES` di `speech.rs` adalah
  yang benar-benar dikirim host — dua literal di dua bahasa tanpa yang mengikat
  keduanya.
  - Kode yang ada di satu sisi saja = bahasa yang dialog tawarkan dan host tolak.
  - Dan karena host me-*resolve* kode asing ke default, bukan menolaknya, gejalanya
    bukan crash: ruangan dibaca dengan aksen yang tidak dipilih siapa pun.
  - Dua sisi sama-sama punya test yang mengunci dirinya sendiri (test Rust yang
    mencantumkan kodenya, test TS yang menggerakkan picker) dan keduanya hijau
    sementara daftarnya beda — persis bentuk bug yang `test:wire` dibuat.
  - Sekarang `test:wire` membaca keempat file dan membandingkannya dua arah, plus
    `DEFAULT_LANGUAGE` di kedua sisi.
  - Ekstraksi Rust-nya sempat memotong pada `]` pertama — yang menutup anotasi tipe
    `&[&str]`, bukan daftar nilainya — sehingga membaca nol kode. Yang menangkapnya
    adalah assertion jumlah > 0, bukan parsesnya; assertion itu yang harus disimpan.

- **Tidak ada CI sama sekali.** `.github/workflows/ci.yml`, empat job: `app`
  (typecheck + 15 file `.mjs`), `rust` (48 test, plus library sistem yang Tauri
  linker-kan), `web` (typecheck + 3 suite), `backend` (17 suite lewat `run_all.py`).
  - Python dipin ke 3.12, bukan `latest`: runner yang diam-diam pindah ke 3.14
    mengubah suite hijau jadi merah tanpa hubungan dengan perubahan yang diuji.
  - Tidak ada build installer dan tidak ada secret. `tauri build` butuh signing
    identity per platform, dan hijau di test tidak mengatakan apa-apa soal itu.

- **Setelan suara tidak ada sampai fiturnya sudah dinyalakan.** Blok language /
  pace / volume / tester disembunyikan sampai salah satu dari tiga toggle suara
  aktif — logika yang masuk akal untuk pace picker tiga opsi, dan tidak untuk blok
  yang isinya termasuk Tester.
  - Tester justru alatnya dipakai untuk menilai *sebelum* decided menyalakan, jadi
    satu-satunya cara Mengeceknya adalah menyalakannya dulu. Dialog yang bagian TTS-nya
    baru muncul setelah TTS sudah dinyalakan adalah dialog yang tidak bisa dipakai
    untuk mencari tahu apa yang terjadi kalau dinyalakan.
  - Sekarang bloknya selalu tampil, dan ada test yang memastikannya ada dengan
    ketiga toggle masih mati.

- **Tooltip gear tidak lagi menyebut section yang tidak ada.** "Theme, font,
  density, panels and model" — tidak ada satu pun "feed" atau "sounds" di sana,
  dan keduanya adalah tempat semua setelan suara ini hidup.

- **Seluruh console merender tanpa styling sama sekali.** `next build` menulis
  `.next/static` di sebelah server bundle dan tidak menyalinnya ke
  `.next/standalone`; `deploy-web.sh`elding memcopinya manual. Asersinya hanya
  mencocokkan `*.js`, jadi stylesheet — satu-satunya aset yang tidak ikut tercopy —
  justru satu-satunya yang tidak pernah diuji. Semua halaman menjawab 200 dan
  hydrate; yang rusak cuma tampilannya, dan itu terbaca sebagai "desainnya jelek".
  `deploy-web.sh` sekarang meng-*assert* stylesheet juga.
- **Tiga kelas dipakai komponen tapi tidak pernah ada di stylesheet.** `.btn` —
  sehingga "Style the overlay" dan "Open live preview" jadi anchor telanjang tanpa
  border atau padding, dan satu-satunya jalan dari stream ke styling-nya terlihat
  seperti bagian dari kalimat di sebelahnya. `.seg button.on` — `color: #fff` di
  atas `background: var(--accent)` yang juga putih, jadi tab terpilih tak terlihat
  di atas background-nya sendiri. `.side-note` — `margin-top: auto` mendorongnya
  400px di bawah item menu terakhir di jendela tinggi.
- **Link overlay terpotong di tengah tanpa scrollbar.** `rows={2}` terlihat wajar
  untuk link pendek dan tidak berguna untuk yang panjang, karena bagian yang
  dipotong adalah justru bagian yang harus dibaca. Sekarang tautan ditampilkan
  dari path-nya (origin ditulis sekali di atas halaman, karena sama di semua
  link), dan teks yang ditampilkan `user-select: none` — tombol Copy selalu
  menyalin URL utuh, dan tidak ada cara tak sengaja menyalin yang dipotong.
- **Polling status room bilek tiap 15 detik.** Effect-nya bergantung pada objek
  `rooms`, yang adalah array baru setiap polling, jadi effect dibongkar-tata ulang
  tiap tick: interval-nya direset dan langsung menjalankan satu sweep status di
  atas yang sedang jalan. Sekarang bergantung pada `roomIds` (string).
- **`PUT` di set `MUTATING` tapi route-nya tidak export `PUT`.** Tidak bisa
  dieksploitasi (Next menolak `PUT` 405 sebelum set itu dibaca), tapi set itu
  adalah daftar "method yang mewajibkan token" dan salah satu isinya tidak pernah
  membaca token sama sekali.

### Docs
- Klaim bahwa `if (origin)` membuat cek same-origin bisa dilewati dengan
  Origin-absen **diverifikasi dan memang bukan celah**: `SameSite=Lax` membuat
  cookie tidak dikirim pada POST lintas situs, dan `/api/account/password` tetap
  menanyakan password lama yang penyerang tidak punya. Perilaku tidak diubah —
  yang ditambahkan hanya penjelasan kenapa dua lapis itu sudah cukup.
- **`api/tests/run_all.py` adalah runner-nya, bukan pytest.** Tidak ada pytest di
  direktori ini: setiap suite adalah script polos dengan helper
  `check(label, cond, detail)` dan `print`, tanpa fungsi `test_*` dan tanpa
  fixture. Akibatnya `python -m pytest tests/ -q` tidak mengumpulkan apa pun dan
  **exit 5** — yang berarti "tidak ada test yang jalan", bukan "test lulus".
  Gate yang disambungkan ke perintah itu akan hijau di atas suite kosong. CI
  menjalankan file ini langsung. Header docstring `run_all.py` sekarang
  menyatakan ini supaya orang berikutnya tidak kehilangan waktu pada exit 5.

### Deployment
- **Backend `20aa24c`..`ae33f2e` sudah live di VPS** (`streamer-api.service`,
  PID 3073870, boot 06:15:22 WIB). Sebelum restart dua prasyarat dikonfirmasi
  lebih dulu, bukan setelah: repo pada `ae33f2e` (HEAD == `origin/main`, working
  tree bersih), dan tidak ada session yang akan putus — `totalConnections: 0`,
  nol aktivitas WebSocket 10 menit sebelumnya, tiga room `Offline` dan satu
  `waiting` (`@d4r311` tidak live).
  - **Bukti pasca-restart, bukan asumsi:** `systemctl status` → `active
    (running)`, `NRestarts: 0`, memori 81.9M dari cap 512M. `/health` → `200`
    dengan `activeRooms: 4`. `/metrics` — modul baru dari build ini — berisi
    angka nyata, bukan objek kosong: `events_in_total: 79` dengan rincian per
    kind (`comment: 22`, `join: 28`, `viewers: 15`, `like: 12`, `follow: 1`,
    `intro: 1`), `sources_active: 4`, `background_tasks: 5` (task registry baru),
    `source_queue_high_water: 11`.
  - **Satu room benar-benar connect dan mengirim frame end to end.** `@zaylinho`
    hidup saat restore, dan socket-nya mengirim 6 frame asli dari stream TikTok:
    `config`, `status`, `join`, `viewers`, `like`, `join`. Frame `status` tidak
    membawa `liveEnded`/`waiting` — benar, karena keduanya hanya dikirim saat
    true dan stream itu memang live.
  - **Overlay token bersifat aditif, bukan pengganti.** `POST
    /api/rooms/{id}/overlay-token` mencetak token (`expiresIn: 21600`), dan
    handshake **tanpa** token tetap diterima. Jadi setiap tautan OBS yang sudah
    ada survive upgrade tanpa diubah.
  - **Yang masih terbuka:** `STREAMKIT_WS_REQUIRE_TOKEN` belum di-set, jadi token
    tetap opsional dan model kapabilitas room-id masih berlaku. Ini P0 yang
    *tereduksi*, bukan *tertutup*.
  - **Watch item, bukan alarm:** `event_loop_lag_max_s: 1.075` adalah maksimum
    atas window uptime, dan stall ~1s saat startup biasa — empat sumber
    TikTokLive attach, koneksi pertama, import settling. Yang perlu diperiksa
    adalah apakah angkanya masih naik setelah proses hangat. Pasangan yang
    menenangkan: `source_queue_high_water: 11` masih jauh dari plafon queue,
    jadi jalur evict newest-wins **teruji tapi belum terbukti live** pada trafik
    produksi.

### Known issues (pre-existing, bukan dari audit ini)
- ~~**Lima suite backend gagal di baseline: `test_avatar`,
  `test_gift_fields`, `test_live_return`, `test_reconnect_budget`,
  `test_viewer_coalesce`.**~~ **Bukan gagal — artefak lingkungan Python 3.9.6.**
  Kelimanya lulus pada venv Python 3.12 yang dipinjam `api/requirements.txt`:
  `tests/run_all.py` melaporkan **30/30 suite lulus**. Jadi backend ini hijau di
  stack yang dipinjam, bukan hanya hijau di tempat ia dites. Catatan dicatat ke
  depan di sini, bukan dengan menulis ulang pesan commit yang sudah di-push.

## [1.1.0] — 2026-10-14

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

[Unreleased]: https://github.com/aldifhr/livechat-app/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/aldifhr/livechat-app/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/aldifhr/livechat-app/releases/tag/v1.0.0