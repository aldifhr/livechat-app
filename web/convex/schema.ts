import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  rooms: defineTable({
    externalId: v.string(),
    name: v.string(),
    username: v.optional(v.string()),
    provider: v.optional(v.string()),
    config: v.optional(v.any()),
    createdAt: v.number(),
    connected: v.optional(v.boolean()),
    connecting: v.optional(v.boolean()),
    waiting: v.optional(v.boolean()),
    liveEnded: v.optional(v.boolean()),
    statusMessage: v.optional(v.string()),
    viewers: v.optional(v.number()),
    providerStatus: v.optional(v.any()),
    autoCreated: v.optional(v.boolean()),
  })
    .index("by_external", ["externalId"])
    .index("by_username", ["username"])
    .index("by_created", ["createdAt"]),

  events: defineTable({
    roomId: v.string(),
    kind: v.string(),
    user: v.optional(v.string()),
    userId: v.optional(v.string()),
    frame: v.any(),
    createdAt: v.number(),
  }).index("by_room_created", ["roomId", "createdAt"]),

  roomSessions: defineTable({
    roomId: v.string(),
    peakViewers: v.number(),
    diamonds: v.number(),
    comments: v.number(),
    joins: v.number(),
    likes: v.number(),
    gifts: v.number(),
    totalEvents: v.number(),
    viewers: v.optional(v.number()),
    startedAt: v.number(),
    lastUpdatedAt: v.number(),
  }).index("by_room", ["roomId"]),

  giveawaySnapshots: defineTable({
    publicId: v.string(),
    roomId: v.optional(v.string()),
    keyword: v.string(),
    createdAt: v.number(),
    data: v.any(),
  })
    .index("by_public", ["publicId"])
    .index("by_created", ["createdAt"]),

  logs: defineTable({
    level: v.string(),
    source: v.string(),
    message: v.string(),
    createdAt: v.number(),
  }).index("by_created", ["createdAt"]),

  metrics: defineTable({
    name: v.string(),
    roomId: v.optional(v.string()),
    value: v.number(),
    createdAt: v.number(),
  }).index("by_name_created", ["name", "createdAt"]),
});
