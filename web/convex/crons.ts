import { cronJobs } from "convex/server";
import { internal } from "./_generated/api";

const convexCrons = cronJobs();

// Daily event pruning. Retention is 48 hours: session totals live in
// roomSessions, so raw events older than that are only history nobody reads.
convexCrons.daily(
  "prune old events",
  { hourUTC: 18, minuteUTC: 0 },
  internal.cleanup.pruneOldEvents,
  { olderThanHours: 48 },
);

export default convexCrons;
