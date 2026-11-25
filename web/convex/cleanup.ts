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
    // Bounded batches scoped by the by_created index: every row the range
    // returns is already older than the cutoff. The previous version took the
    // first 500 rows of the whole table and stopped at a short batch, so a
    // burst could leave old rows behind until the next daily run and stretch
    // the 48-hour retention.
    for (let pass = 0; pass < 20; pass++) {
      const rows = await ctx.db
        .query("events")
        .withIndex("by_created", (q: any) => q.lt("createdAt", cutoff))
        .take(500);
      if (!rows.length) break;
      for (const row of rows) await ctx.db.delete(row._id);
      deleted += rows.length;
    }
    return { deleted, cutoff };
  },
});
