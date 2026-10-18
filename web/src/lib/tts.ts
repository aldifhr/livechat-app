/**
 * How much of a message the text-to-speech reads.
 *
 * Shared by the browser queue (`client/tts.ts`) and the `/api/tts` route, which
 * clamps to the same length, so an over-long message is read the same amount
 * whether it is trimmed in the browser or at the proxy. Isomorphic — a plain
 * number with no runtime dependency, so the server route imports the contract
 * rather than the browser implementation behind it.
 */
export const TTS_MAX_CHARS = 180
