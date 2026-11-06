import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireToken, tokenArg } from "./auth";

function cleanHandle(username: string) {
  return username.trim().replace(/^@/, "").toLowerCase();
}

export async function resolveRoom(ctx: any, roomId: string) {
  if (!roomId) return null;
  const byExternal = await ctx.db
    .query("rooms")
    .withIndex("by_external", (q: any) => q.eq("externalId", roomId))
    .collect();
  if (byExternal[0]) return byExternal[0];
  try {
    const byId = await ctx.db.get(roomId as any);
    if (byId) return byId;
  } catch {}
  const all = await ctx.db.query("rooms").collect();
  return all.find((r: any) => String(r._id) === roomId) ?? null;
}

function pub(r: any) {
  return {
    id: r.externalId || String(r._id),
    name: r.name || "Untitled",
    username: r.username || "",
    config: r.config || {},
    createdAt: r.createdAt || 0,
    provider: r.provider || "tiktok",
  };
}

export const list = query({
  args: { ...tokenArg,},
  handler: async (ctx, args) => {
    requireToken(args);
    const rooms = await ctx.db.query("rooms").collect();
    return rooms.map(pub);
  },
});

export const publicList = query({
  args: { ...tokenArg,},
  handler: async (ctx) => {
    const rooms = await ctx.db.query("rooms").collect();
    return rooms.map((r: any) => ({
      id: r.externalId || String(r._id),
      username: r.username || "",
      name: r.name || "",
      connected: !!r.connected,
      provider: r.provider || "tiktok",
    }));
  },
});

export const get = query({
  args: { ...tokenArg, roomId: v.string() },
  handler: async (ctx, args) => {
    requireToken(args);
    const room = await resolveRoom(ctx, args.roomId);
    if (!room) return null;
    return { ...pub(room), connected: !!room.connected, createdAt: room.createdAt || 0 };
  },
});

export const getByExternal = query({
  args: { ...tokenArg, externalId: v.string() },
  handler: async (ctx, args) => {
    requireToken(args);
    const room = await resolveRoom(ctx, args.externalId);
    if (!room) return null;
    return {
      ...pub(room),
      _id: String(room._id),
      connected: !!room.connected,
      connecting: !!room.connecting,
      waiting: !!room.waiting,
      liveEnded: !!room.liveEnded,
      statusMessage: room.statusMessage || "",
      viewers: room.viewers ?? 0,
    };
  },
});

export const create = mutation({
  args: { ...tokenArg,
    name: v.string(),
    username: v.optional(v.string()),
    provider: v.optional(v.string()),
    config: v.optional(v.any()),
    externalId: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireToken(args);
    const externalId = args.externalId || crypto.randomUUID();
    const id = await ctx.db.insert("rooms", {
      externalId,
      name: args.name.trim() || "Untitled",
      username: args.username?.trim().replace(/^@/, "") || "",
      provider: args.provider || "tiktok",
      config: args.config || {},
      createdAt: Date.now(),
      connected: false,
    });
    return { id: externalId, _id: String(id) };
  },
});

export const update = mutation({
  args: { ...tokenArg,
    roomId: v.string(),
    name: v.optional(v.string()),
    username: v.optional(v.string()),
    provider: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireToken(args);
    const room = await resolveRoom(ctx, args.roomId);
    if (!room) return { id: args.roomId, notFound: true };
    const patch: any = {};
    if (args.name !== undefined) patch.name = args.name.trim() || "Untitled";
    if (args.username !== undefined) patch.username = args.username.trim().replace(/^@/, "");
    if (args.provider !== undefined) patch.provider = args.provider;
    if (args.username !== undefined && patch.username !== room.username) {
      patch.connected = false;
      patch.connecting = false;
      patch.liveEnded = false;
    }
    await ctx.db.patch(room._id, patch);
    return { id: room.externalId || String(room._id) };
  },
});

export const updateConfig = mutation({
  args: { ...tokenArg, roomId: v.string(), config: v.any() },
  handler: async (ctx, args) => {
    requireToken(args);
    const room = await resolveRoom(ctx, args.roomId);
    if (!room) return { id: args.roomId, notFound: true };
    await ctx.db.patch(room._id, { config: args.config });
    return { id: room.externalId || String(room._id) };
  },
});

export const deleteRoom = mutation({
  args: { ...tokenArg, roomId: v.string() },
  handler: async (ctx, args) => {
    requireToken(args);
    const room = await resolveRoom(ctx, args.roomId);
    if (!room) return { id: args.roomId, notFound: true };
    await ctx.db.delete(room._id);
    return { id: room.externalId || String(room._id) };
  },
});

export const findOrCreateByUsername = mutation({
  args: { ...tokenArg,
    username: v.string(),
    name: v.optional(v.string()),
    config: v.optional(v.any()),
    provider: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    requireToken(args);
    const normalized = cleanHandle(args.username);
    const rooms = await ctx.db.query("rooms").collect();
    const existing = rooms.find(
      (r: any) => (r.username ?? "").trim().replace(/^@/, "").toLowerCase() === normalized,
    );
    if (existing) {
      return { id: existing.externalId || String(existing._id), created: false };
    }
    if (rooms.length >= 20) throw new Error("Auto-created room limit reached");
    const externalId = crypto.randomUUID();
    await ctx.db.insert("rooms", {
      externalId,
      name: args.name?.trim() || cleanHandle(args.username),
      username: cleanHandle(args.username),
      provider: args.provider || "tiktok",
      config: args.config || {},
      createdAt: Date.now(),
      connected: false,
      autoCreated: true,
    });
    return { id: externalId, created: true };
  },
});

export const setStatus = mutation({
  args: { ...tokenArg,
    roomId: v.string(),
    connected: v.optional(v.boolean()),
    connecting: v.optional(v.boolean()),
    waiting: v.optional(v.boolean()),
    liveEnded: v.optional(v.boolean()),
    message: v.optional(v.string()),
    viewers: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireToken(args);
    const room = await resolveRoom(ctx, args.roomId);
    if (!room) return { ok: false };
    const patch: any = {};
    if (args.connected !== undefined) patch.connected = args.connected;
    if (args.connecting !== undefined) patch.connecting = args.connecting;
    if (args.waiting !== undefined) patch.waiting = args.waiting;
    if (args.liveEnded !== undefined) patch.liveEnded = args.liveEnded;
    if (args.message !== undefined) patch.statusMessage = args.message;
    if (args.viewers !== undefined) patch.viewers = args.viewers;
    await ctx.db.patch(room._id, patch);
    return { ok: true };
  },
});

export const getSession = query({
  args: { ...tokenArg, roomId: v.string() },
  handler: async (ctx, args) => {
    requireToken(args);
    const room = await resolveRoom(ctx, args.roomId);
    if (!room) return null;
    const rid = String(room._id);
    const [session] = await ctx.db
      .query("roomSessions")
      .withIndex("by_room", (q: any) => q.eq("roomId", rid))
      .collect();
    const events = await ctx.db
      .query("events")
      .withIndex("by_room_created", (q: any) => q.eq("roomId", rid))
      .take(5000);
    const totals: Record<string, number> = {};
    const gifters = new Map<string, { id: string; nickname: string; diamonds: number }>();
    for (const e of events as any[]) {
      totals[e.kind] = (totals[e.kind] || 0) + 1;
      if (e.kind === "gift") {
        const key = e.userId || e.user || "";
        if (key) {
          const cur = gifters.get(key) || { id: key, nickname: e.user || key, diamonds: 0 };
          cur.diamonds += e.frame?.value ?? 0;
          gifters.set(key, cur);
        }
      }
    }
    const topGifters = [...gifters.values()]
      .filter((g) => g.id)
      .sort((a, b) => b.diamonds - a.diamonds || a.nickname.localeCompare(b.nickname))
      .slice(0, 20);
    const liveSeconds = session
      ? Math.max(0, Math.round(((session.lastUpdatedAt || Date.now()) - (session.startedAt || Date.now())) / 1000))
      : null;
    return {
      connected: !!room.connected,
      totals,
      repeats: {},
      viewers: room.viewers ?? session?.viewers ?? null,
      viewers_age: null,
      peak_viewers: session?.peakViewers ?? 0,
      peak_viewers_age: null,
      live_seconds: liveSeconds,
      total_diamonds: session?.diamonds ?? 0,
      topGifters,
    };
  },
});

export const analytics = query({
  args: { ...tokenArg, provider: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireToken(args);
    let rooms = await ctx.db.query("rooms").collect();
    if (args.provider) rooms = rooms.filter((r: any) => (r.provider || "tiktok") === args.provider);
    const out: any = {
      total_rooms: rooms.length,
      total_viewers: 0,
      total_peak_viewers: 0,
      total_diamonds: 0,
      total_events: 0,
      rooms: [],
      topGifters: [] as any[],
    };
    const gifterTotals = new Map<string, { id: string; nickname: string; diamonds: number }>();
    for (const room of rooms as any[]) {
      const rid = String(room._id);
      const [session] = await ctx.db
        .query("roomSessions")
        .withIndex("by_room", (q: any) => q.eq("roomId", rid))
        .collect();
      const viewers = room.viewers ?? session?.viewers ?? 0;
      const peak = session?.peakViewers ?? 0;
      const diamonds = session?.diamonds ?? 0;
      const totalEvents = session?.totalEvents ?? 0;
      out.total_viewers += viewers;
      out.total_peak_viewers += peak;
      out.total_diamonds += diamonds;
      out.total_events += totalEvents;
      out.rooms.push({
        id: room.externalId || rid,
        username: room.username || "",
        connected: !!room.connected,
        viewers,
        peak_viewers: peak,
        total_diamonds: diamonds,
        events: totalEvents,
        live_seconds: session
          ? Math.max(0, Math.round(((session.lastUpdatedAt || Date.now()) - (session.startedAt || Date.now())) / 1000))
          : null,
      });
      const events = await ctx.db
        .query("events")
        .withIndex("by_room_created", (q: any) => q.eq("roomId", rid))
        .take(5000);
      for (const e of events as any[]) {
        if (e.kind !== "gift") continue;
        const key = e.userId || e.user || "";
        if (!key) continue;
        const cur = gifterTotals.get(key) || { id: key, nickname: e.user || key, diamonds: 0 };
        cur.diamonds += e.frame?.value ?? 0;
        gifterTotals.set(key, cur);
      }
    }
    out.rooms.sort((a: any, b: any) => b.viewers - a.viewers);
    out.topGifters = [...gifterTotals.values()]
      .filter((g) => g.id)
      .sort((a, b) => b.diamonds - a.diamonds || a.nickname.localeCompare(b.nickname))
      .slice(0, 20);
    return out;
  },
});
