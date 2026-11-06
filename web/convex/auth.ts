import { ConvexError, v } from "convex/values";

/**
 * Token gate for Convex functions.
 *
 * The deployment is public on the internet (kit-backend.aldifhr.my.id), so
 * without this anyone who finds the URL could delete rooms or post fake
 * gifts straight at Convex, bypassing the dashboard's session gate entirely.
 * Every caller that is allowed — the Next gateway and the TikTok bridge —
 * runs server-side and attaches STREAMKIT_TOKEN, which the deployment holds
 * as a Convex env var. Reads that OBS browser sources need with no session
 * (rooms:publicList, events:health without rooms) stay open deliberately.
 */
export const tokenArg = { token: v.optional(v.string()) };

export function requireToken(args: { token?: string }) {
  const expected = process.env.STREAMKIT_TOKEN || "";
  const given = args.token || "";
  const ok =
    expected !== "" &&
    given.length === expected.length &&
    timingSafeEqual(given, expected);
  if (!ok) throw new ConvexError("Invalid or missing token");
}

function timingSafeEqual(a: string, b: string) {
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
