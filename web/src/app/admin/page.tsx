import Rooms from '@/sections/Rooms'

/**
 * The room list — the console's home.
 *
 * This is the layout's index, so the address is /admin and not /admin/rooms. A
 * console's home has one name; giving it a second one just to look symmetrical
 * means the one people type and the one they get pasted are different.
 */
export default function RoomsPage() {
  return <Rooms />
}