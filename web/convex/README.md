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
`/etc/convex/env`). It is exposed publicly at `https://kit-backend.aldifhr.my.id`
via nginx (Convex on `/`, bridge on `/ws/` and `/api/room-connect*`).
