import ExcelTextEditor from '@/sections/ExcelTextEditor'

/**
 * Editable copy for the Excel backgrounds, under the stream it belongs to.
 * The room id comes in the query string because the overlay link needs it and
 * the handle alone cannot name a room; the page only builds links, it writes
 * nothing back to the store.
 */
export default async function ExcelTextPage({
  searchParams,
}: {
  searchParams: Promise<{ room?: string }>
}) {
  const { room } = await searchParams
  return <ExcelTextEditor roomId={room ?? ''} />
}
