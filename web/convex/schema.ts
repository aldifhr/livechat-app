import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export const schema = defineSchema({
  rooms: defineTable({
    name: v.string(),
    username: v.optional(v.string()),
    provider: v.optional(v.string()),
    config: v.optional(v.any()),
    createdAt: v.number(),
    connected: v.optional(v.boolean()),
    providerStatus: v.optional(v.any()),
    autoCreated: v.optional(v.boolean()),
  }).index("by_username", ["username"]).index("by_created", ["createdAt"]),

  events: defineTable({
    roomId: v.string(),
    roomExternalId: v.optional(v.string()),
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
    startedAt: v.number(),
    lastUpdatedAt: v.number(),
  }).index("by_room", ["roomId"]),

  giveawaySnapshots: defineTable({
    roomId: v.optional(v.string()),
    keyword: v.string(),
    createdAt: v.number(),
    data: v.any(),
  }).index("by_created", ["createdAt"]),

  metrics: defineTable({
    name: v.string(),
    roomId: v.optional(v.string()),
    value: v.number(),
    createdAt: v.number(),
  }).index("by_name_created", ["name", "createdAt"]),
});
