import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireToken, tokenArg } from "./auth";
import { resolveRoom } from "./rooms";

const COMMENT = "comment";
const KIND_MAP: Record<string, string> = {
  chat: COMMENT,
  comment: COMMENT,
};

function normKind(kind: string) {
  return KIND_MAP[kind] || kind;
}

export const appendEvent = mutation({
  args: { ...tokenArg,
    roomId: v.string(),
    kind: v.string(),
    user: v.optional(v.string()),
    userId: v.optional(v.string()),
    frame: v.optional(v.any()),
    createdAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireToken(args);
    const room = await resolveRoom(ctx, args.roomId);
    if (!room) return { id: "", notFound: true };
    const rid = String(room._id);
    const kind = normKind(args.kind);
    const frame = args.frame || { type: kind, user: args.user || "", userId: args.userId || args.user || "" };
    const createdAt = args.createdAt ?? Date.now();
    const id = await ctx.db.insert("events", {
      roomId: rid,
      kind,
      user: args.user || frame.user || "",
      userId: args.userId || frame.userId || frame.user || "",
      frame,
      createdAt,
    });
    const [session] = await ctx.db
      .query("roomSessions")
      .withIndex("by_room", (q: any) => q.eq("roomId", rid))
      .collect();
    const diamonds = kind === "gift" ? Number(frame.value ?? 0) : 0;
    const patch: any = {
      totalEvents: (session?.totalEvents ?? 0) + 1,
      diamonds: (session?.diamonds ?? 0) + diamonds,
      comments: (session?.comments ?? 0) + (kind === "comment" ? 1 : 0),
      joins: (session?.joins ?? 0) + (kind === "join" ? 1 : 0),
      likes: (session?.likes ?? 0) + (kind === "like" ? 1 : 0),
      gifts: (session?.gifts ?? 0) + (kind === "gift" ? 1 : 0),
      lastUpdatedAt: createdAt,
    };
    if (kind === "viewers" && typeof frame.count === "number") {
      patch.viewers = frame.count;
      patch.peakViewers = Math.max(session?.peakViewers ?? 0, frame.count);
      await ctx.db.patch(room._id, { viewers: frame.count });
    }
    if (session) {
      await ctx.db.patch(session._id, patch);
    } else {
      await ctx.db.insert("roomSessions", {
        roomId: rid,
        peakViewers: patch.peakViewers ?? 0,
        diamonds: patch.diamonds,
        comments: patch.comments,
        joins: patch.joins,
        likes: patch.likes,
        gifts: patch.gifts,
        totalEvents: 1,
        startedAt: createdAt,
        lastUpdatedAt: createdAt,
      });
    }
    return { id: String(id) };
  },
});

export const recentForRoom = query({
  args: { ...tokenArg, roomId: v.string(), limit: v.optional(v.number()), since: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireToken(args);
    const room = await resolveRoom(ctx, args.roomId);
    if (!room) return [];
    const rid = String(room._id);
    const rows = await ctx.db
      .query("events")
      .withIndex("by_room_created", (q: any) => q.eq("roomId", rid))
      .order("desc")
      .take(Math.min(args.limit ?? 50, 500));
    const list = (rows as any[])
      .filter((e) => (args.since ? e.createdAt > args.since : true))
      .sort((a, b) => a.createdAt - b.createdAt);
    return list.map((e) => e.frame);
  },
});

export const topChatters = query({
  args: { ...tokenArg, roomId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    requireToken(args);
    const room = await resolveRoom(ctx, args.roomId);
    if (!room) return [];
    const rid = String(room._id);
    const events = await ctx.db
      .query("events")
      .withIndex("by_room_created", (q: any) => q.eq("roomId", rid))
      .take(5000);
    const counts = new Map<string, { id: string; nickname: string; count: number }>();
    for (const e of events as any[]) {
      if (e.kind !== "comment") continue;
      const key = e.userId || e.user || "";
      if (!key) continue;
      const cur = counts.get(key) || { id: key, nickname: e.user || key, count: 0 };
      cur.count += 1;
      counts.set(key, cur);
    }
    return [...counts.values()]
      .sort((a, b) => b.count - a.count || a.nickname.localeCompare(b.nickname))
      .slice(0, args.limit ?? 10);
  },
});

export const trigger = mutation({
  args: { ...tokenArg,
    roomId: v.string(),
    kind: v.string(),
    user: v.optional(v.string()),
    userId: v.optional(v.string()),
    text: v.optional(v.string()),
    title: v.optional(v.string()),
    icon: v.optional(v.string()),
    count: v.optional(v.number()),
    diamonds: v.optional(v.number()),
    months: v.optional(v.number()),
    amount: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    requireToken(args);
    const room = await resolveRoom(ctx, args.roomId);
    if (!room) return { notFound: true };
    const kind = normKind(args.kind);
    const frame: any = { type: kind };
    if (kind === "comment") {
      frame.user = args.user || "";
      frame.userId = args.userId || args.user || "";
      frame.text = args.text || "";
    } else if (kind === "gift") {
      frame.user = args.user || "";
      frame.userId = args.userId || args.user || "";
      frame.giftName = args.text || "Gift";
      frame.count = args.count ?? 1;
      frame.value = (args.diamonds ?? args.amount ?? 0) * (args.count ?? 1);
    } else if (kind === "alert") {
      frame.title = args.title || "";
      frame.text = args.text || "";
      frame.icon = args.icon || "★";
      if (args.amount !== undefined) frame.amount = args.amount;
    } else if (kind === "like") {
      frame.user = args.user || "";
      frame.userId = args.userId || args.user || "";
      frame.count = args.count ?? 1;
      frame.totalLikes = 0;
    } else if (kind === "join" || kind === "follow" || kind === "share") {
      frame.user = args.user || "";
      frame.userId = args.userId || args.user || "";
      if (kind === "share") frame.count = args.count ?? 1;
    } else if (kind === "subscription") {
      frame.user = args.user || "";
      frame.userId = args.userId || args.user || "";
      frame.months = args.months ?? 0;
    } else {
      frame.text = args.text || "";
      if (args.user) frame.user = args.user;
    }
    const rid = String(room._id);
    await ctx.db.insert("events", {
      roomId: rid,
      kind,
      user: frame.user || "",
      userId: frame.userId || frame.user || "",
      frame,
      createdAt: Date.now(),
    });
    return { ok: true, kind };
  },
});

export const metricsSummary = query({
  args: { ...tokenArg, roomId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireToken(args);
    const sessions = await ctx.db.query("roomSessions").collect();
    const base = { totalEvents: 0, comments: 0, joins: 0, likes: 0, gifts: 0, diamonds: 0 };
    for (const s of sessions as any[]) {
      if (args.roomId) {
        const room = await resolveRoom(ctx, args.roomId);
        if (!room || String(room._id) !== s.roomId) continue;
      }
      base.totalEvents += s.totalEvents || 0;
      base.comments += s.comments || 0;
      base.joins += s.joins || 0;
      base.likes += s.likes || 0;
      base.gifts += s.gifts || 0;
      base.diamonds += s.diamonds || 0;
    }
    return base;
  },
});

export const health = query({
  args: { ...tokenArg, withRooms: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    if (args.withRooms) requireToken(args);
    const rooms = await ctx.db.query("rooms").collect();
    const activeRooms = (rooms as any[]).filter((r) => r.connected).length;
    if (!args.withRooms) return { status: "ok", activeRooms };
    return {
      status: "ok",
      uptimeSeconds: 0,
      activeRooms,
      websocketConnections: 0,
      queuedMessages: 0,
      rooms: Object.fromEntries(
        (rooms as any[]).map((r) => [
          r.externalId || String(r._id),
          {
            status: {
              connected: !!r.connected,
              connecting: !!r.connecting,
              waiting: !!r.waiting,
              liveEnded: !!r.liveEnded,
              message: r.statusMessage || "",
              viewers: r.viewers ?? 0,
            },
          },
        ]),
      ),
    };
  },
});

export const appendLog = mutation({
  args: { ...tokenArg, level: v.string(), source: v.string(), message: v.string() },
  handler: async (ctx, args) => {
    requireToken(args);
    const id = await ctx.db.insert("logs", { ...args, createdAt: Date.now() });
    return { id: String(id) };
  },
});

export const listLogs = query({
  args: { ...tokenArg, limit: v.optional(v.number()), level: v.optional(v.string()), q: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireToken(args);
    const rank: Record<string, number> = { debug: 0, info: 1, warning: 2, error: 3, critical: 4 };
    const min = rank[args.level || "info"] ?? 1;
    let rows = await ctx.db.query("logs").withIndex("by_created").order("desc").take(500);
    rows = (rows as any[]).filter((r) => (rank[r.level] ?? 1) >= min);
    if (args.q) {
      const q = args.q.toLowerCase();
      rows = rows.filter((r) => r.message.toLowerCase().includes(q) || r.source.toLowerCase().includes(q));
    }
    const total = rows.length;
    const entries = rows.slice(0, Math.min(args.limit ?? 200, 500)).map((r) => ({
      at: new Date(r.createdAt).toISOString(),
      level: r.level,
      source: r.source,
      message: r.message,
    }));
    return { entries, total, capacity: 500 };
  },
});
