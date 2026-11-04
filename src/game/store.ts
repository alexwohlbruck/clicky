import { reactive, toRaw } from 'vue'
import type {
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
  const blank = { name: localStorage.getItem('clicky-name') ?? '', games: 0, wins: 0, presses: 0, peakPps: 0 }
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
  reactions: [] as FloatingReaction[],
  error: '',
  profile: loadProfile(),
  /** Our own presses this game and in the last second, for the HUD. */
  myPresses: 0,
  myRecent: [] as number[],
  /** Presses sent but not yet reflected in a server state. */
  unconfirmed: 0,
})

/** The effects layer listens here; the store doesn't know about shaders. */
export const hooks = {
  press: (_team: Team, _mine: boolean) => {},
  roundOver: (_winner: Team, _gameOver: boolean) => {},
  countdown: () => {},
  go: () => {},
  frenzy: (_active: boolean) => {},
  track: (_track: Track, _elapsedMs: number) => {},
}

let socket: WebSocket | null = null
let pendingJoin: ClientMessage | null = null
let reactionKey = 0

export function saveProfile() {
  localStorage.setItem(PROFILE_KEY, JSON.stringify(state.profile))
  localStorage.setItem('clicky-name', state.profile.name)
}

function connect() {
  const url = new URL('/ws', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  socket = new WebSocket(url)
  socket.onopen = () => {
    state.connected = true
    if (pendingJoin) send(pendingJoin)
  }
  socket.onmessage = (event) => receive(JSON.parse(event.data) as ServerMessage)
  socket.onclose = () => {
    state.connected = false
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
      state.screen = 'room'
      pendingJoin = null
      history.replaceState(null, '', `?room=${message.room.id}`)
      break

    case 'room':
      state.room = message.room
      if (state.me) state.me = message.room.players.find((p) => p.id === state.me!.id) ?? state.me
      break

    case 'state': {
      const { room, me } = state
      if (!room || !me) return
      room.count = message.count
      // Our own presses already burst when we pressed; only show the rest.
      for (const team of ['creators', 'destroyers'] as const) {
        let others = message.presses[team]
        if (team === me.team) {
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
        state.countdownEndsAt = performance.now() + (message.countdownMs ?? 3000)
        state.myPresses = 0
        state.showResults = false
        hooks.countdown()
      }
      if (message.phase === 'playing' && previous === 'countdown') hooks.go()
      if ((message.phase === 'roundOver' || message.phase === 'gameOver') && previous === 'playing' && message.winner) {
        hooks.roundOver(message.winner, message.phase === 'gameOver')
      }
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
      }
      // Shown once the game-over flash has played, if we're still there.
      setTimeout(() => {
        if (toRaw(state.results) === message.results) state.showResults = true
      }, 6200)
      break
    }

    case 'track':
      state.track = message.track
      hooks.track(message.track, message.elapsedMs)
      break

    case 'react': {
      const player = state.room?.players.find((p) => p.id === message.id)
      float(message.emoji, player?.team ?? 'creators')
      break
    }

    case 'frenzy':
      state.frenzyUntil = message.active ? performance.now() + message.ms : 0
      hooks.frenzy(message.active)
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
