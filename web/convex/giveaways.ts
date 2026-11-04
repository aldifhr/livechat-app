import { v } from "convex/values";
import { mutation, query } from "./_generated/server";

export const saveSnapshot = mutation({
  args: { keyword: v.string(), data: v.any(), roomId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("giveawaySnapshots", { keyword: args.keyword, data: args.data, roomId: args.roomId, createdAt: Date.now() });
    return { id: String(id) };
  },
});

export const getSnapshot = query({
  args: { id: v.string() },
  handler: async (ctx, args) => {
    return await ctx.db.get(args.id as any);
  },
});

export const listSnapshots = query({
  args: {},
  handler: async (ctx) => {
    return await ctx.db.query("giveawaySnapshots").withIndex("by_created").order("desc").take(100);
  },
});
