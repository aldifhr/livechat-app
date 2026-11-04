import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

const METRIC_BY_KIND: Record<string, string> = {
  chat: "comments",
  join: "joins",
  like: "likes",
  gift: "gifts",
};

function roomStateUpdates(kind: string, value: number) {
  return { peakViewers: 0, diamonds: 0, comments: 0, joins: 0, likes: 0, gifts: 0, totalEvents: 0 };
}

export const appendEvent = mutation({
  args: {
    roomId: v.string(),
    kind: v.string(),
    user: v.optional(v.string()),
    userId: v.optional(v.string()),
    text: v.optional(v.string()),
    title: v.optional(v.string()),
    icon: v.optional(v.string()),
    value: v.optional(v.number()),
    diamonds: v.optional(v.number()),
    count: v.optional(v.number()),
    months: v.optional(v.number()),
    meta: v.optional(v.any()),
    createdAt: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const createdAt = args.createdAt ?? Date.now();
    const id = await ctx.db.insert("events", { ...args, createdAt });
    const metricName = METRIC_BY_KIND[args.kind] || "events";
    const [session] = await ctx.db.query("roomSessions").withIndex("by_room", (q: any) => q.eq("roomId", args.roomId)).collect();
    if (session) {
      await ctx.db.patch(session._id, {
        totalEvents: (session.totalEvents ?? 0) + 1,
        diamonds: (session.diamonds ?? 0) + (args.diamonds ?? args.value ?? 0),
        comments: (session.comments ?? 0) + (args.kind === "chat" ? 1 : 0),
        joins: (session.joins ?? 0) + (args.kind === "join" ? 1 : 0),
        likes: (session.likes ?? 0) + (args.kind === "like" ? 1 : 0),
        gifts: (session.gifts ?? 0) + (args.kind === "gift" ? 1 : 0),
        lastUpdatedAt: createdAt,
      });
    } else {
      await ctx.db.insert("roomSessions", {
        roomId: args.roomId,
        peakViewers: 0,
        diamonds: args.diamonds ?? args.value ?? 0,
        comments: args.kind === "chat" ? 1 : 0,
        joins: args.kind === "join" ? 1 : 0,
        likes: args.kind === "like" ? 1 : 0,
        gifts: args.kind === "gift" ? 1 : 0,
        totalEvents: 1,
        startedAt: createdAt,
        lastUpdatedAt: createdAt,
      });
    }
    return { id: String(id), metricName };
  },
});

export const recentForRoom = query({
  args: { roomId: v.string(), limit: v.optional(v.number()) },
  handler: async (ctx, args) => {
    return await ctx.db.query("events").withIndex("by_room_created", (q: any) => q.eq("roomId", args.roomId)).order("desc").take(args.limit ?? 50);
  },
});

export const metricsSummary = query({
  args: { roomId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const events = await ctx.db.query("events").collect();
    const filtered = args.roomId ? events.filter((e: any) => e.roomId === args.roomId) : events;
    const base = { totalEvents: filtered.length, comments: 0, joins: 0, likes: 0, gifts: 0, diamonds: 0 };
    for (const e of filtered) {
      if (e.kind === "chat") base.comments++;
      if (e.kind === "join") base.joins++;
      if (e.kind === "like") base.likes++;
      if (e.kind === "gift") base.gifts++;
      base.diamonds += e.diamonds ?? e.value ?? 0;
    }
    return base;
  },
});

export const health = query({
  args: { withRooms: v.optional(v.boolean()) },
  handler: async (ctx, args) => {
    if (!args.withRooms) return { status: "ok" };
    const rooms = await ctx.db.query("rooms").collect();
    const activeRooms = rooms.filter((r: any) => r.connected).length;
    return {
      status: "ok",
      uptimeSeconds: 0,
      activeRooms,
      websocketConnections: activeRooms,
      queuedMessages: 0,
      rooms: Object.fromEntries(rooms.map((r: any) => [String(r._id), { status: r.providerStatus || {} }]))
    };
  },
});
