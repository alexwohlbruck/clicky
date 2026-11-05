import { reactive, toRaw } from 'vue'
import { ACHIEVEMENTS, earnedByGame, type Achievement } from './achievements'
import type {
  ChatMessage,
  ClientMessage,
  Emoji,
  Player,
  Results,
  RoomSnapshot,
  ServerMessage,
  Settings,
  Team,
  Track,
} from '../../shared/protocol'

export type Screen = 'intro' | 'home' | 'room'

export interface Profile {
  name: string
  achievements: string[]
  games: number
  wins: number
  presses: number
  peakPps: number
}

export interface FloatingReaction {
  key: number
  emoji: Emoji
  team: Team
  x: number
}

const PROFILE_KEY = 'clicky-profile'

function loadProfile(): Profile {
  const blank = { name: localStorage.getItem('clicky-name') ?? '', achievements: [] as string[], games: 0, wins: 0, presses: 0, peakPps: 0 }
  try {
    return { ...blank, ...JSON.parse(localStorage.getItem(PROFILE_KEY) ?? '{}') }
  } catch {
    return blank
  }
}

export const state = reactive({
  screen: 'intro' as Screen,
  connected: false,
  room: null as RoomSnapshot | null,
  me: null as Player | null,
  track: null as Track | null,
  results: null as Results | null,
  showResults: false,
  frenzyUntil: 0,
  countdownEndsAt: 0,
  /** Time between the countdown's ticks: a whole number of beats. */
  tickMs: 1000,
  reactions: [] as FloatingReaction[],
  error: '',
  /** The latest achievement, for its toast. */
  unlocked: null as Achievement | null,
  profile: loadProfile(),
  /** Our own presses this game and in the last second, for the HUD. */
  myPresses: 0,
  myRecent: [] as number[],
  /** Presses sent but not yet reflected in a server state. */
  unconfirmed: 0,
  /** Presses this game, by player id, from the server. */
  tally: {} as Record<string, number>,
  chat: [] as ChatMessage[],
  /** The surge orb's place on the bar, in segments. */
  orb: null as number | null,
  /** Who took the last surge, for the banner. */
  surge: null as { team: Team; until: number } | null,
})

/** The effects layer listens here; the store doesn't know about shaders. */
export const hooks = {
  press: (_team: Team, _mine: boolean) => {},
  roundOver: (_winner: Team, _gameOver: boolean) => {},
  /** A countdown or round-over that gives way to play in `endsInMs`, ticking every `tickMs`. */
  countdown: (_endsInMs: number, _tickMs: number) => {},
  waiting: (_endsInMs: number) => {},
  go: () => {},
  frenzy: (_active: boolean) => {},
  track: (_track: Track, _elapsedMs: number) => {},
  /** A better reading of how far into its song the room is. */
  retime: (_elapsedMs: number) => {},
  surge: (_team: Team, _at: number) => {},
  orb: () => {},
  react: () => {},
  chat: () => {},
  roster: (_joined: boolean) => {},
}

let unlockTimer = 0

/** Record achievements, toasting any that are new. */
export function unlock(ids: string[]) {
  const fresh = ids.filter((id) => !state.profile.achievements.includes(id))
  if (!fresh.length) return
  state.profile.achievements = [...state.profile.achievements, ...fresh]
  saveProfile()
  // One toast at a time; a few seconds each.
  fresh.forEach((id, i) =>
    setTimeout(() => {
      state.unlocked = ACHIEVEMENTS.find((a) => a.id === id) ?? null
      clearTimeout(unlockTimer)
      unlockTimer = window.setTimeout(() => (state.unlocked = null), 3200)
    }, i * 3400),
  )
}

let socket: WebSocket | null = null
let pendingJoin: ClientMessage | null = null
let reactionKey = 0

export function saveProfile() {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile))
  localStorage.setItem('clicky-name', state.profile.name)
}

/**
 * The server's clock, on ours: a few pings, keeping the quickest round trip,
 * whose middle is when the server read its clock. Timings the server sends
 * (when a song started, when play begins) are then exact here, however long
 * a message took to arrive or to be handled.
 */
export const clock = { offset: 0, rtt: Infinity, synced: false }
/** When the room's song started, on the server's clock, to re-read as the clock improves. */
let trackStartedAt: number | null = null
let pingTimer = 0
export const serverNow = () => performance.now() + clock.offset
/** A server time as milliseconds from now, or `fallback` until the clock is known. */
const fromNow = (serverTime: number | undefined, fallback: number) => (clock.synced && serverTime !== undefined ? serverTime - serverNow() : fallback)

function ping() {
  send({ t: 'ping', at: performance.now() })
}

function connect() {
  const url = new URL('/ws', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  socket = new WebSocket(url)
  socket.onopen = () => {
    state.connected = true
    if (pendingJoin) send(pendingJoin)
    // A burst to measure the clock, then the odd one to keep it honest.
    clock.rtt = Infinity
    for (let i = 0; i < 6; i++) setTimeout(ping, i * 150)
    for (let i = 1; i <= 10; i++) setTimeout(ping, i * 2000)
    clearInterval(pingTimer)
    pingTimer = window.setInterval(ping, 10_000)
  }
  socket.onmessage = (event) => receive(JSON.parse(event.data) as ServerMessage)
  socket.onclose = () => {
    state.connected = false
    clearInterval(pingTimer)
    socket = null
    // Rejoin the same room if we were in one; it may have closed, in which case we land home.
    if (state.room) {
      pendingJoin = { t: 'join', name: state.profile.name, room: state.room.id }
      setTimeout(connect, 1000)
    }
  }
}

function send(message: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function join(message: ClientMessage) {
  state.error = ''
  saveProfile()
  pendingJoin = message
  if (socket?.readyState === WebSocket.OPEN) send(message)
  else if (!socket) connect()
}

export const actions = {
  quickPlay: () => join({ t: 'join', name: state.profile.name }),
  createRoom: () => join({ t: 'join', name: state.profile.name, create: true }),
  joinRoom: (code: string) => join({ t: 'join', name: state.profile.name, room: code.trim().toUpperCase() }),
  /** Put a room up on a big screen without taking a seat. */
  watch: (code: string) => join({ t: 'join', name: '', room: code.trim().toUpperCase(), watch: true }),
  leave() {
    pendingJoin = null
    state.results = null
    state.room = null
    state.me = null
    state.showResults = false
    socket?.close()
    socket = null
    state.screen = 'home'
    history.replaceState(null, '', location.pathname)
  },
  press() {
    const { room, me } = state
    if (!room || !me || room.phase !== 'playing') return
    send({ t: 'press' })
    const now = performance.now()
    state.unconfirmed++
    state.myPresses++
    state.myRecent = [...state.myRecent.filter((at) => now - at < 1000), now]
    hooks.press(me.team, true)
  },
  switchTeam: (team: Team) => send({ t: 'team', team }),
  start: () => send({ t: 'start' }),
  settings: (settings: Partial<Settings>) => send({ t: 'settings', settings }),
  react: (emoji: Emoji) => send({ t: 'react', emoji }),
  skip: () => send({ t: 'skip' }),
  say: (text: string) => send({ t: 'chat', text }),
  kick: (id: string) => send({ t: 'kick', id }),
}

function float(emoji: Emoji, team: Team) {
  const key = ++reactionKey
  state.reactions.push({ key, emoji, team, x: Math.random() })
  setTimeout(() => {
    state.reactions = state.reactions.filter((r) => r.key !== key)
  }, 2600)
}

function receive(message: ServerMessage) {
  switch (message.t) {
    case 'welcome':
      state.me = message.you
      state.room = message.room
      state.unconfirmed = 0
      state.results = null
      state.showResults = false
      state.chat = []
      state.tally = {}
      state.screen = 'room'
      pendingJoin = null
      history.replaceState(null, '', `?${message.you ? 'room' : 'watch'}=${message.room.id}`)
      break

    case 'room': {
      // Real people coming and going, not the bot being switched on.
      const humans = (room: RoomSnapshot | null) => room?.players.filter((p) => !p.bot).length ?? 0
      const before = humans(state.room)
      if (state.room?.id === message.room.id && humans(message.room) !== before) hooks.roster(humans(message.room) > before)
      state.room = message.room
      if (state.me) state.me = message.room.players.find((p) => p.id === state.me!.id) ?? state.me
      break
    }

    case 'state': {
      const { room, me } = state
      if (!room) return
      room.count = message.count
      state.tally = message.tally
      // Our own presses already burst when we pressed; only show the rest.
      for (const team of ['creators', 'destroyers'] as const) {
        let others = message.presses[team]
        if (team === me?.team) {
          const ours = Math.min(state.unconfirmed, others)
          state.unconfirmed -= ours
          others -= ours
        }
        for (let i = 0; i < Math.min(others, 6); i++) hooks.press(team, false)
      }
      break
    }

    case 'phase': {
      const room = state.room
      if (!room) return
      const previous = room.phase
      Object.assign(room, { phase: message.phase, winner: message.winner, score: message.score, count: message.count })
      state.unconfirmed = 0
      if (message.phase === 'countdown') {
        state.countdownEndsAt = performance.now() + fromNow(message.endsAt, message.endsInMs ?? 3000)
        state.tickMs = message.tickMs ?? 1000
        state.myPresses = 0
        state.tally = {}
        state.orb = null
        state.showResults = false
        hooks.countdown(fromNow(message.endsAt, message.endsInMs ?? 3000), message.tickMs ?? 1000)
      }
      if (message.phase === 'playing' && (previous === 'countdown' || previous === 'roundOver')) hooks.go()
      if ((message.phase === 'roundOver' || message.phase === 'gameOver') && previous === 'playing' && message.winner) {
        hooks.roundOver(message.winner, message.phase === 'gameOver')
      }
      if (message.phase === 'roundOver' && message.endsInMs) hooks.waiting(fromNow(message.endsAt, message.endsInMs))
      break
    }

    case 'results': {
      state.results = message.results
      const mine = message.results.players.find((p) => p.id === state.me?.id)
      if (mine) {
        const profile = state.profile
        profile.games++
        if (mine.team === message.results.winner) profile.wins++
        profile.presses += mine.presses
        profile.peakPps = Math.max(profile.peakPps, mine.peakPps)
        saveProfile()
        // After the results screen appears.
        const earned = earnedByGame(profile, message.results, mine.id)
        setTimeout(() => unlock(earned), 7000)
      }
      // Shown once the game-over flash has played, if we're still there.
      setTimeout(() => {
        if (toRaw(state.results) === message.results) state.showResults = true
      }, 6200)
      break
    }

    case 'track':
      state.track = message.track
      trackStartedAt = message.startedAt
      hooks.track(message.track, -fromNow(message.startedAt, -message.elapsedMs))
      break

    case 'pong': {
      const now = performance.now()
      const rtt = now - message.at
      // Older samples count for a little less, so a drifting clock is followed.
      if (rtt <= clock.rtt * 1.2 || rtt < 30) {
        clock.rtt = Math.min(rtt, clock.rtt)
        clock.offset = message.server - (message.at + rtt / 2)
        clock.synced = true
        if (trackStartedAt !== null && state.room) hooks.retime(serverNow() - trackStartedAt)
      }
      break
    }

    case 'react': {
      const player = state.room?.players.find((p) => p.id === message.id)
      float(message.emoji, player?.team ?? 'creators')
      hooks.react()
      break
    }

    case 'frenzy':
      state.frenzyUntil = message.active ? performance.now() + message.ms : 0
      if (message.active) unlock(['frenzy'])
      hooks.frenzy(message.active)
      break

    case 'chat':
      state.chat = [...state.chat.slice(-49), message.message]
      if (message.message.id !== state.me?.id) hooks.chat()
      break

    case 'orb': {
      const at = state.orb
      state.orb = message.at
      if (message.at !== null && at === null) hooks.orb()
      if (message.by && at !== null) {
        state.surge = { team: message.by, until: performance.now() + 1600 }
        if (message.by === state.me?.team) unlock(['surge'])
        hooks.surge(message.by, at)
      }
      break
    }

    case 'kicked':
      actions.leave()
      state.error = 'The host removed you from the room'
      break

    case 'error':
      state.error = message.message
      pendingJoin = null
      if (!state.room) {
        socket?.close()
        socket = null
      }
      break
  }
}
