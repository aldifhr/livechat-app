# StreamKit Convex backend

Convex (self-hosted) is the backend for StreamKit. All state — rooms, events,
sessions, giveaways, logs — lives in Convex. The only other process is the
Node TikTok bridge in `backend/`: it holds the long-lived TikTok socket and
fans Convex events out to overlay WebSockets. Convex Functions cannot hold a
socket open for hours, which is why the bridge exists.

Deploy with:

```sh
cd web
CONVEX_SELF_HOSTED_URL=http://127.0.0.1:3210 CONVEX_SELF_HOSTED_ADMIN_KEY=... npm run convex:deploy
npm run convex:import:rooms
```

Self-hosted Convex runs as `convex-local.service` (binary
`/opt/convex/convex-local-backend`, data in `/var/lib/convex`, env in
`/etc/convex/env`). The unit file lives in `/root/convex-local.service` and must
be installed and enabled on the VPS — an uninstalled unit leaves nginx proxying
port 3210 to nothing, which surfaces as `502 Bad Gateway` on `kit-backend`:

```sh
cp /root/convex-local.service /etc/systemd/system/convex-local.service
systemctl daemon-reload
systemctl enable --now convex-local
```

`/etc/convex/env` holds `INSTANCE_NAME`, `INSTANCE_SECRET` and
`CONVEX_ADMIN_KEY` (mode 600). If it is lost, the running bridge still carries
them in `/proc/$(systemctl show -p MainPID --value tiktok-bridge)/environ`.
