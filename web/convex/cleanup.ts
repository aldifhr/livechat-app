import { v } from "convex/values";
import { internalMutation } from "./_generated/server";

/**
 * Delete events older than the retention window.
 *
 * The old backend kept session counters in memory and dropped raw events
 * immediately, so nothing accumulated. Convex persists every event, so
 * without this the table grows forever on a busy live. Session totals live
 * in roomSessions (not derived from events at read time, except the
 * leaderboards' last-5000 scan), so dropping old rows does not change the
 * numbers a dashboard shows — it only bounds the table.
 *
 * Runs on a daily cron (see crons.ts). Deletes in batches because one
 * mutation cannot page through an unbounded table.
 */
export const pruneOldEvents = internalMutation({
  args: { olderThanHours: v.optional(v.number()) },
  handler: async (ctx, args) => {
    const cutoff = Date.now() - (args.olderThanHours ?? 48) * 3600_000;
    let deleted = 0;
    // Bounded batches: each pass takes the oldest 500 and deletes them.
    for (let pass = 0; pass < 20; pass++) {
      const rows = await ctx.db.query("events").take(500);
      const old = (rows as any[]).filter((e) => e.createdAt < cutoff);
      if (!old.length) break;
      for (const e of old) await ctx.db.delete(e._id);
      deleted += old.length;
      if (old.length < 500) break;
    }
    return { deleted, cutoff };
  },
});
