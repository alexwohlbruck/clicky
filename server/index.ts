import { mkdir } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { ROOM_CAPACITY, type ClientMessage, type RoomListing, type ServerMessage, type Track } from '../shared/protocol'
import tracks from '../shared/tracks.json'
import { Analyses } from './analysis'
import { Leaderboard } from './leaderboard'
import { Room } from './room'

const PORT = Number(process.env.PORT ?? (process.env.NODE_ENV === 'production' ? 3700 : 3701))
const JUKEBOX_URL = process.env.JUKEBOX_URL ?? 'https://jukebox.wohlbruck.dev'
const ROOT = join(import.meta.dir, '..')
const DIST = join(ROOT, 'dist')
const DATA = process.env.DATA_DIR ?? join(ROOT, 'data')
const TICK_MS = 1000 / 30

const playlist = tracks as Track[]
const knownTracks = new Set(playlist.map((track) => track.id))
const rooms = new Map<string, Room>()

await mkdir(DATA, { recursive: true })
const leaderboard = await Leaderboard.open(join(DATA, 'leaderboard.json'))

/** Beats, bars and drops for every track, worked out once and kept. */
const analyses = new Analyses(DATA, (id) => {
  const url = new URL('/v1/stream', JUKEBOX_URL)
  url.searchParams.set('spotifyTrackId', id)
  return url.href
})
/** What a room asks while it plays: the answer if it's ready, and work on it if not. */
const music = (id: string) => analyses.peek(id) ?? (void analyses.get(id, true), null)
void analyses.warm(playlist.map((track) => track.id))

interface SocketData {
  id: string
  roomId?: string
}

/** Four letters, skipping ones that read alike. */
function roomCode() {
  const letters = 'ABCDEFGHJKMNPQRSTUVWXYZ'
  let code = ''
  do code = Array.from({ length: 4 }, () => letters[Math.floor(Math.random() * letters.length)]).join('')
  while (rooms.has(code))
  return code
}

function openRoom(isPublic: boolean, now: number) {
  const room = new Room({ id: roomCode(), public: isPublic, tracks: playlist, now, music, onResults: (results) => leaderboard.record(results) })
  rooms.set(room.id, room)
  return room
}

/** Quick play joins the fullest public room with space, or opens one. */
function quickPlay(now: number) {
  const open = [...rooms.values()]
    .filter((room) => room.public && room.humanCount < ROOM_CAPACITY)
    .sort((a, b) => b.humanCount - a.humanCount)[0]
  return open ?? openRoom(true, now)
}

function listings(): RoomListing[] {
  return [...rooms.values()]
    .filter((room) => room.public && room.humanCount > 0)
    .map((room) => ({ id: room.id, players: room.humanCount, phase: room.phase, score: room.score }))
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

/**
 * A song the server has kept, with byte ranges so the browser can seek in it.
 * 404 until it's been analysed; the client falls back to Jukebox's stream.
 */
async function serveSong(id: string, request: Request): Promise<Response> {
  const file = knownTracks.has(id) ? analyses.song(id) : null
  if (!file || !(await file.exists())) return new Response('Not kept yet', { status: 404 })
  const size = file.size
  const headers = { 'Content-Type': 'audio/mpeg', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=86400' }
  const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('Range') ?? '')
  if (!range) return new Response(file, { headers: { ...headers, 'Content-Length': String(size) } })
  const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]))
  const end = range[1] && range[2] ? Math.min(size - 1, Number(range[2])) : size - 1
  if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
  return new Response(file.slice(start, end + 1), {
    status: 206,
    headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) },
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
    if (/^\/music\/\w+\/file$/.test(url.pathname)) return serveSong(url.pathname.split('/')[2]!, request)
    if (url.pathname.startsWith('/music/')) return proxyMusic(url)
    if (url.pathname === '/api/rooms') return Response.json(listings())
    if (url.pathname === '/api/leaderboard') return Response.json(leaderboard.top())
    if (url.pathname.startsWith('/api/analysis/')) {
      const id = url.pathname.split('/').pop() ?? ''
      if (!knownTracks.has(id)) return new Response('Unknown track', { status: 404 })
      const analysis = await analyses.get(id, true)
      // Analyses never change, so the browser can keep them.
      return analysis ? Response.json(analysis, { headers: { 'Cache-Control': 'public, max-age=86400' } }) : new Response('Not analysed', { status: 503 })
    }
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
      const id = socket.data.id
      const room = socket.data.roomId ? rooms.get(socket.data.roomId) : undefined
      const send = (out: ServerMessage) => socket.send(JSON.stringify(out))

      switch (message.t) {
        case 'ping':
          // Answered straight away: the round trip is how the client measures our clock.
          if (typeof message.at === 'number') send({ t: 'pong', at: message.at, server: Date.now() })
          break
        case 'join': {
          if (room) return
          let joined: Room | undefined
          if (message.create) joined = openRoom(false, now)
          else if (message.room) joined = rooms.get(String(message.room).toUpperCase())
          else joined = quickPlay(now)

          if (!joined) {
            send({ t: 'error', message: `No room called ${String(message.room).toUpperCase()}` })
            return
          }
          if (message.watch) {
            socket.data.roomId = joined.id
            joined.watch(id, send, now)
            return
          }
          if (joined.humanCount >= ROOM_CAPACITY) {
            send({ t: 'error', message: 'That room is full' })
            return
          }
          socket.data.roomId = joined.id
          joined.join(id, String(message.name ?? ''), send, now)
          break
        }
        case 'press':
          room?.press(id, now)
          break
        case 'skip':
          room?.skipTrack(now)
          break
        case 'team':
          room?.switchTeam(id, message.team, now)
          break
        case 'start':
          room?.start(id, now)
          break
        case 'settings':
          room?.updateSettings(id, message.settings ?? {}, now)
          break
        case 'react':
          room?.react(id, message.emoji, now)
          break
        case 'chat':
          room?.say(id, message.text, now)
          break
        case 'kick':
          room?.kick(id, message.id, now)
          break
      }
    },

    close(socket) {
      const room = socket.data.roomId ? rooms.get(socket.data.roomId) : undefined
      if (!room) return
      room.leave(socket.data.id, Date.now())
      if (room.empty) rooms.delete(room.id)
    },
  },
})

setInterval(() => {
  const now = Date.now()
  for (const room of rooms.values()) room.tick(now)
}, TICK_MS)

console.log(`clicky server listening on http://${server.hostname}:${server.port}`)
