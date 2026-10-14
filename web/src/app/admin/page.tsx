import Streams from '@/sections/Streams'

/**
 * The stream list — the console's home.
 *
 * This is the layout's index, so the address is /admin and not /admin/streams. A
 * console's home has one name; giving it a second one just to look symmetrical
 * means the one people type and the one they get pasted are different.
 *
 * It is called Streams rather than Rooms because that is what the operator is
 * thinking about: a room is a record on the backend, a stream is the thing being
 * broadcast. Every screen here talks about the second.
 */
export default function StreamsPage() {
  return <Streams />
}