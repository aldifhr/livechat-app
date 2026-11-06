import { v } from "convex/values";
import { mutation, query } from "./_generated/server";
import { requireToken, tokenArg } from "./auth";

function newPublicId() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s.slice(0, 16);
}

export const saveSnapshot = mutation({
  args: { ...tokenArg, keyword: v.optional(v.string()), data: v.any(), roomId: v.optional(v.string()) },
  handler: async (ctx, args) => {
    requireToken(args);
    const publicId = newPublicId();
    const createdAt = Date.now();
    const keyword = args.keyword || args.data?.keyword || args.data?.report?.keyword || "giveaway";
    await ctx.db.insert("giveawaySnapshots", {
      publicId,
      keyword,
      data: args.data,
      roomId: args.roomId,
      createdAt,
    });
    return { id: publicId, createdAt: new Date(createdAt).toISOString() };
  },
});

async function findByPublic(ctx: any, id: string) {
  const rows = await ctx.db
    .query("giveawaySnapshots")
    .withIndex("by_public", (q: any) => q.eq("publicId", id))
    .collect();
  if (rows[0]) return rows[0];
  try {
    const byId = await ctx.db.get(id as any);
    if (byId) return byId;
  } catch {}
  return null;
}

export const getSnapshot = query({
  args: { ...tokenArg, id: v.string() },
  handler: async (ctx, args) => {
    requireToken(args);
    const snap = await findByPublic(ctx, args.id);
    if (!snap) return null;
    return {
      id: snap.publicId || String(snap._id),
      createdAt: new Date(snap.createdAt).toISOString(),
      report: snap.data?.report || snap.data,
    };
  },
});

export const listSnapshots = query({
  args: { ...tokenArg,},
  handler: async (ctx, args) => {
    requireToken(args);
    const rows = await ctx.db.query("giveawaySnapshots").withIndex("by_created").order("desc").take(100);
    return (rows as any[]).map((s) => {
      const report = s.data?.report || s.data || {};
      return {
        id: s.publicId || String(s._id),
        createdAt: new Date(s.createdAt).toISOString(),
        report: {
          format: report.format || "livechat-giveaway-audit-v1",
          streamHandle: report.streamer || report.streamHandle || "",
          isTestRun: !!report.testMode,
          entrantCount: Array.isArray(report.entrants) ? report.entrants.length : 0,
          winnerCount: Array.isArray(report.draws) ? report.draws.length : 0,
        },
      };
    });
  },
});

export const deleteSnapshot = mutation({
  args: { ...tokenArg, id: v.string() },
  handler: async (ctx, args) => {
    requireToken(args);
    const snap = await findByPublic(ctx, args.id);
    if (!snap) return { notFound: true };
    await ctx.db.delete(snap._id);
    return { status: "deleted" };
  },
});
