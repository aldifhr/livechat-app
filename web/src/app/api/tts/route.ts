import { NextRequest, NextResponse } from 'next/server'
import { TTS_MAX_CHARS } from '@/lib/tts'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q = searchParams.get('q')?.trim()
  if (!q) {
    return new NextResponse('Missing text', { status: 400 })
  }

  const clean = q.slice(0, TTS_MAX_CHARS)
  // Language is configurable so a non-Indonesian stream is not read in the
  // wrong voice. A query override lets a browser source pick its own; the env
  // value is the deployment default. Both are validated before they reach the
  // upstream URL, so this cannot become an open proxy for arbitrary params.
  const requested = searchParams.get('lang')?.trim() || process.env.STREAMKIT_TTS_LANG?.trim() || 'id'
  const lang = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(requested) ? requested : 'id'
  const googleUrl = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(clean)}&tl=${encodeURIComponent(lang)}&client=tw-ob`

  try {
    const res = await fetch(googleUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    })

    if (!res.ok) {
      return new NextResponse('Failed to fetch TTS', { status: res.status })
    }

    const audioData = await res.arrayBuffer()
    return new NextResponse(audioData, {
      headers: {
        'Content-Type': 'audio/mpeg',
        'Cache-Control': 'public, max-age=86400, s-maxage=86400',
      },
    })
  } catch (err) {
    return new NextResponse('Internal error', { status: 500 })
  }
}
