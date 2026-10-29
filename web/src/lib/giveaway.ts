// The giveaway's draw and report shape live in `shared/`, so the dashboard and
// the public snapshot page derive a winner the same way and a report from either
// verifies by the same steps. This re-export keeps the existing
// `@/lib/giveaway` imports.
export * from '@shared/giveaway'
