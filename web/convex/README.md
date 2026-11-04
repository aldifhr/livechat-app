# StreamKit Convex deployment

This directory holds the new Convex backend for StreamKit. The existing
FastAPI service remains only as the light TikTok adapter: it connects to
TikTok, normalizes events, and calls these Convex mutations. All room, event,
session, giveaway, and metrics state lives in Convex.

Deploy with:

```sh
cd web
npm run convex:dev
npm run convex:deploy
npm run convex:import:rooms
```

Set `NEXT_PUBLIC_CONVEX_URL` and `CONVEX_URL` to the deployment URL. The
Python adapter uses `CONVEX_URL` plus `CONVEX_ADMIN_KEY` to ingest events.
