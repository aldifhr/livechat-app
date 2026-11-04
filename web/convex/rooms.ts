import { ConvexError, v } from "convex/values";
import { mutation, query } from "./_generated/server";

function cleanHandle(username: string) {
  return username.trim().replace(/^@/, "").toLowerCase();
}

async function findRoomByUsername(ctx: any, username: string) {
  const normalized = cleanHandle(username);
  if (!normalized) return null;
  const rooms = await ctx.db.query("rooms").collect();
  return rooms.find((r: any) => (r.username ?? "").trim().replace(/^@/, "").toLowerCase() === normalized) ?? null;
}

export const list = query({
  args: {},
  handler: async (ctx) => {
    const rooms = await ctx.db.query("rooms").collect();
    return rooms.map((r: any) => ({
      id: String(r._id),
      name: r.name || "Untitled",
      username: r.username || "",
      config: r.config || {},
      createdAt: r.createdAt || 0,
      provider: r.provider || "tiktok",
    }));
  },
});

export const publicList = query({
  args: {},
  handler: async (ctx) => {
    const rooms = await ctx.db.query("rooms").collect();
    return rooms.map((r: any) => ({
      id: String(r._id),
      username: r.username || "",
      name: r.name || "",
      connected: !!r.connected,
      provider: r.provider || "tiktok",
    }));
  },
});

export const get = query({
  args: { roomId: v.string() },
  handler: async (ctx, args) => {
    const room = await ctx.db.get(args.roomId as any);
    return room || null;
  },
});

export const create = mutation({
  args: {
    name: v.string(),
    username: v.optional(v.string()),
    provider: v.optional(v.string()),
    config: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("rooms", {
      name: args.name.trim() || "Untitled",
      username: args.username?.trim().replace(/^@/, "") || "",
      provider: args.provider || "tiktok",
      config: args.config || {},
      createdAt: Date.now(),
      connected: false,
    });
    return { id: String(id) };
  },
});

export const update = mutation({
  args: {
    roomId: v.string(),
    name: v.optional(v.string()),
    username: v.optional(v.string()),
    provider: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const patch: any = {};
    if (args.name !== undefined) patch.name = args.name.trim() || "Untitled";
    if (args.username !== undefined) patch.username = args.username.trim().replace(/^@/, "");
    if (args.provider !== undefined) patch.provider = args.provider;
    await ctx.db.patch(args.roomId as any, patch);
    return { id: args.roomId };
  },
});

export const updateConfig = mutation({
  args: { roomId: v.string(), config: v.any() },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.roomId as any, { config: args.config });
    return { id: args.roomId };
  },
});

export const deleteRoom = mutation({
  args: { roomId: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.delete(args.roomId as any);
    return { id: args.roomId };
  },
});

export const findOrCreateByUsername = mutation({
  args: {
    username: v.string(),
    name: v.optional(v.string()),
    config: v.optional(v.any()),
  },
  handler: async (ctx, args) => {
    const existing = await findRoomByUsername(ctx, args.username);
    if (existing) {
      await ctx.db.patch(existing._id, { connected: true });
      return { id: String(existing._id), created: false };
    }
    const id = await ctx.db.insert("rooms", {
      name: args.name?.trim() || args.username.trim().replace(/^@/, ""),
      username: args.username.trim().replace(/^@/, ""),
      provider: "tiktok",
      config: args.config || {},
      createdAt: Date.now(),
      connected: true,
      autoCreated: true,
    });
    return { id: String(id), created: true };
  },
});

export const getSession = query({
  args: { roomId: v.string() },
  handler: async (ctx, args) => {
    const [session] = await ctx.db.query("roomSessions").withIndex("by_room", (q: any) => q.eq("roomId", args.roomId)).collect();
    return session || null;
  },
});
