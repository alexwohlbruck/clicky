import { join, normalize } from 'node:path'
import { ROOM_CAPACITY, type ClientMessage, type Track } from '../shared/protocol'
import tracks from '../shared/tracks.json'
import { Room } from './room'

const PORT = Number(process.env.PORT ?? (process.env.NODE_ENV === 'production' ? 3700 : 3701))
const JUKEBOX_URL = process.env.JUKEBOX_URL ?? 'https://jukebox.wohlbruck.dev'
const DIST = join(import.meta.dir, '..', 'dist')
const TICK_MS = 1000 / 30

const playlist = tracks as Track[]
const knownTracks = new Set(playlist.map((track) => track.id))
const rooms = new Map<string, Room>()

interface SocketData {
  id: string
  roomId?: string
}

/** Public games fill the newest room with space; a named room is private. */
function findRoom(requested: string | undefined, now: number): Room {
  const named = requested?.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 24)
  if (named) {
    const room = rooms.get(named) ?? new Room({ id: named, tracks: playlist, now })
    rooms.set(named, room)
    return room
  }

  const open = [...rooms.values()].reverse().find((room) => room.id.startsWith('~') && room.humanCount < ROOM_CAPACITY)
  if (open) return open

  const room = new Room({ id: `~${crypto.randomUUID().slice(0, 8)}`, tracks: playlist, now })
  rooms.set(room.id, room)
  return room
}

/**
 * Jukebox only allows CORS from the portfolio, so its streams come through
 * here. Same-origin audio is also what lets Web Audio analyse the music.
 */
async function proxyMusic(url: URL): Promise<Response> {
  const id = url.pathname.split('/').pop() ?? ''
  if (!knownTracks.has(id)) return new Response('Unknown track', { status: 404 })

  const upstream = new URL('/v1/stream', JUKEBOX_URL)
  upstream.searchParams.set('spotifyTrackId', id)
  for (const key of ['startMs', 'requestedAtMs']) {
    const value = url.searchParams.get(key)
    if (value && /^\d{1,13}$/.test(value)) upstream.searchParams.set(key, value)
  }

  const response = await fetch(upstream)
  return new Response(response.body, {
    status: response.status,
    headers: {
      'Content-Type': response.headers.get('Content-Type') ?? 'audio/mpeg',
      'Cache-Control': 'no-store',
    },
  })
}

async function serveStatic(url: URL): Promise<Response> {
  const path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '')
  const file = Bun.file(join(DIST, path))
  if (path !== '/' && (await file.exists())) return new Response(file)
  return new Response(Bun.file(join(DIST, 'index.html')))
}

const server = Bun.serve<SocketData>({
  port: PORT,
  hostname: '0.0.0.0',

  async fetch(request, server) {
    const url = new URL(request.url)

    if (url.pathname === '/ws') {
      const upgraded = server.upgrade(request, { data: { id: crypto.randomUUID() } })
      return upgraded ? undefined : new Response('Expected a WebSocket', { status: 426 })
    }
    if (url.pathname.startsWith('/music/')) return proxyMusic(url)
    if (url.pathname === '/health') return Response.json({ ok: true, rooms: rooms.size })

    return serveStatic(url)
  },

  websocket: {
    message(socket, raw) {
      let message: ClientMessage
      try {
        message = JSON.parse(String(raw))
      } catch {
        return
      }

      const now = Date.now()
      const room = socket.data.roomId ? rooms.get(socket.data.roomId) : undefined

      switch (message.t) {
        case 'join': {
          if (room) return
          const joined = findRoom(message.room, now)
          socket.data.roomId = joined.id
          joined.join(socket.data.id, String(message.name ?? ''), (out) => socket.send(JSON.stringify(out)), now)
          break
        }
        case 'press':
          room?.press(socket.data.id, now)
          break
        case 'skip':
          room?.skipTrack(now)
          break
      }
    },

    close(socket) {
      const room = socket.data.roomId ? rooms.get(socket.data.roomId) : undefined
      if (!room) return
      room.leave(socket.data.id, Date.now())
      if (room.humanCount === 0) rooms.delete(room.id)
    },
  },
})

setInterval(() => {
  const now = Date.now()
  for (const room of rooms.values()) room.tick(now)
}, TICK_MS)

console.log(`clicky server listening on http://${server.hostname}:${server.port}`)
