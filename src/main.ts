import './style.css'
import { MAX, START, type Player, type RoomSnapshot, type ServerMessage, type Team } from '../shared/protocol'
import { Sound } from './audio'
import { Flash, GAME_OVER, INTRO, ROUND_OVER, type FlashEvent, type Frames } from './flash'
import { Kind } from './fx/particles'
import { Stage } from './fx/stage'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T

const el = {
  root: document.documentElement,
  stage: $('stage'),
  app: $('app'),
  canvas: $<HTMLCanvasElement>('fx'),
  frame: document.querySelector<HTMLElement>('.frame')!,
  bar: $('bar'),
  control: $('control'),
  hint: $('hint'),
  join: $<HTMLFormElement>('join'),
  name: $<HTMLInputElement>('name'),
  call: $('call'),
  percent: $('percent'),
  scores: $('scores'),
  scoreCreators: $('score-creators'),
  scoreDestroyers: $('score-destroyers'),
  rosterCreators: $('roster-creators'),
  rosterDestroyers: $('roster-destroyers'),
  music: $('music'),
  trackTitle: $('track-title'),
  trackArtist: $('track-artist'),
  mute: $('mute'),
  skip: $('skip'),
  flash: $('flash'),
  flashText: $('flash-text'),
  flashPrompt: $('flash-prompt'),
}

type Screen = 'intro' | 'name' | 'game'

const touch = matchMedia('(pointer: coarse)').matches
const sound = new Sound()
let stage: Stage | null = null

let screen: Screen = 'intro'
let room: RoomSnapshot | null = null
let me: Player | null = null
let socket: WebSocket | null = null

/** The bar as drawn: eases toward the server's count plus our unconfirmed presses. */
let shown = 1
let unconfirmed = 0

// Effect state, all decaying toward calm.
let trauma = 0
let pulse = { creators: 0, destroyers: 0 }
let pressRate = 0
let spike = 0
let shockAt = -Infinity
let shockStrength = 0
let shockOrigin = { x: 0, y: 0 }

let flash: { player: Flash; clock: () => number } | null = null
let introStarted = false
let introStartedAt = 0

// --- Layout -----------------------------------------------------------------

let frameRect = { x: 0, y: 0, w: 1, h: 1 }
let barRect = { x: 0, y: 0, w: 1, h: 1 }

function measure() {
  const frame = el.frame.getBoundingClientRect()
  frameRect = { x: frame.x + el.frame.clientLeft, y: frame.y + el.frame.clientTop, w: el.frame.clientWidth, h: el.frame.clientHeight }
  // The band spans the frame's inner width, like the original's full-width bar.
  const bar = el.bar.getBoundingClientRect()
  barRect = { x: frameRect.x, y: bar.y, w: frameRect.w, h: bar.height }
  el.root.style.setProperty('--flash-scale', String(Math.min(1, innerWidth / 1500, innerHeight / 700)))
  stage?.resize()
}

new ResizeObserver(measure).observe(el.app)

const tip = () => ({ x: barRect.x + barRect.w * shown, y: barRect.y + barRect.h / 2 })

// --- Effects ----------------------------------------------------------------

function shock(x: number, y: number, strength: number) {
  shockAt = performance.now()
  shockStrength = strength
  shockOrigin = { x, y }
}

function burstPress(team: Team, mine: boolean) {
  const { x, y } = tip()
  pulse[team] = Math.min(1.5, pulse[team] + (mine ? 0.7 : 0.35))
  trauma = Math.min(1, trauma + (mine ? 0.09 : 0.04))
  pressRate += 1

  if (team === 'creators') {
    stage?.particles.emit({ x, y, count: mine ? 46 : 18, kind: Kind.Spark, speed: 900, angle: 0, spread: Math.PI * 1.7, height: 36, life: 0.75, size: 10 })
  } else {
    stage?.particles.emit({ x, y, count: mine ? 30 : 12, kind: Kind.Debris, speed: 620, angle: Math.PI * 1.35, spread: Math.PI * 1.1, height: 40, life: 1.4, size: 11 })
  }
}

function celebrate(winner: Team, big: boolean) {
  const { x, y } = tip()
  shock(x, y, 1.2)
  trauma = 1
  spike = 1
  const kind = winner === 'creators' ? Kind.ConfettiCreators : Kind.ConfettiDestroyers
  const columns = big ? 8 : 5
  for (let i = 0; i < columns; i++) {
    stage?.particles.emit({
      x: frameRect.x + (frameRect.w * (i + 0.5)) / columns,
      y: -20,
      count: big ? 260 : 160,
      kind,
      speed: 500,
      angle: Math.PI / 2,
      spread: 1.2,
      width: frameRect.w / columns,
      life: 3.2,
      size: 13,
    })
  }
  stage?.particles.emit({ x, y, count: 500, kind: Kind.Spark, speed: 1600, life: 1.1, size: 12 })
}

/** The intro's extra layer: everything the keyframes do also hits the shader. */
function onIntroEvent(event: FlashEvent) {
  const center = { x: innerWidth / 2, y: innerHeight / 2 }
  const text = el.flashText.getBoundingClientRect()

  switch (event.type) {
    case 'letter':
      // Each letter lands with a shock and throws shards off its right edge.
      shock(text.right, center.y, 0.8)
      trauma = Math.min(1, trauma + 0.45)
      spike = Math.max(spike, 0.6)
      stage?.particles.emit({ x: text.right - 20, y: center.y, count: 260, kind: Kind.Shard, speed: 1300, height: text.height * 0.6, life: 1.4, size: 14 })
      break
    case 'size':
      shock(center.x, center.y, 0.6)
      trauma = Math.min(1, trauma + 0.35)
      spike = Math.max(spike, 0.5)
      break
    case 'warp':
      spike = 1
      trauma = Math.min(1, trauma + 0.25)
      stage?.particles.emit({ x: center.x, y: center.y, count: 120, kind: Kind.Shard, speed: 1700, width: text.width, height: 10, life: 0.8, size: 9 })
      break
    case 'toggle': {
      // The slow strobe pops a ring of shards; the fast one is pure noise.
      const frantic = event.period < 100
      spike = Math.max(spike, frantic ? 1 : 0.55)
      if (frantic) {
        stage?.particles.emit({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, count: 40, kind: Kind.Shard, speed: 1100, life: 0.6, size: 10 })
      } else {
        shock(center.x, center.y, 0.5)
        stage?.particles.emit({ x: center.x, y: center.y, count: 180, kind: Kind.Shard, speed: 1500, life: 1.2, size: 12 })
      }
      break
    }
    case 'end':
      shock(center.x, center.y, 1.4)
      trauma = 1
      stage?.particles.emit({ x: center.x, y: center.y, count: 900, kind: Kind.Spark, speed: 2200, life: 1.4, size: 12 })
      break
  }
}

function onRoundEvent(event: FlashEvent) {
  if (event.type === 'letter') {
    trauma = Math.min(1, trauma + 0.2)
    const text = el.flashText.getBoundingClientRect()
    stage?.particles.emit({ x: text.right - 10, y: text.y + text.height / 2, count: 60, kind: Kind.Shard, speed: 900, height: text.height * 0.5, life: 1, size: 10 })
  }
  if (event.type === 'toggle') spike = Math.max(spike, 0.4)
}

function playFlash(frames: Frames, text: string, onEvent: (event: FlashEvent) => void, clock: () => number, onEnd: () => void) {
  el.flash.hidden = false
  el.app.dataset.flashing = ''
  const player = new Flash(frames, text, el.flashText, (event) => {
    onEvent(event)
    if (event.type === 'end') {
      flash = null
      el.flash.hidden = true
      delete el.app.dataset.flashing
      onEnd()
    }
  })
  flash = { player, clock }
}

// --- Screens ----------------------------------------------------------------

function show(next: Screen) {
  screen = next
  el.app.dataset.screen = next
  const playing = next === 'game'
  el.join.hidden = playing
  el.call.hidden = !playing
  el.percent.hidden = !playing
  // Hidden but still laid out, so the bar stays centred as in the original.
  el.scores.style.visibility = playing ? '' : 'hidden'
  el.music.hidden = !playing || !el.trackTitle.textContent
  if (next === 'name') {
    el.name.value = localStorage.getItem('clicky-name') ?? ''
    el.name.focus()
  }
  measure()
}

function startIntro() {
  introStarted = true
  sound.unlock()
  el.flashPrompt.textContent = ''
  const started = performance.now()
  introStartedAt = started
  // Follow the music when it plays; fall back to the wall clock when it can't.
  let musicPlaying = false
  sound.playIntro().then(() => (musicPlaying = true), () => {})
  const clock = () => (musicPlaying && !sound.music.paused ? sound.music.currentTime * 1000 : performance.now() - started)
  playFlash(INTRO, 'clicky', onIntroEvent, clock, () => show('name'))
}

function skipIntro() {
  if (!flash) return
  flash.player.update(Number.MAX_SAFE_INTEGER)
}

// --- Network ----------------------------------------------------------------

function connect(name: string) {
  const params = new URLSearchParams(location.search)
  const url = new URL('/ws', location.href)
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  socket = new WebSocket(url)
  socket.onopen = () => send({ t: 'join', name, room: params.get('room') ?? undefined })
  socket.onmessage = (event) => receive(JSON.parse(event.data) as ServerMessage)
  socket.onclose = () => {
    socket = null
    room = null
    setTimeout(() => connect(name), 1000)
  }
}

function send(message: unknown) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
}

function receive(message: ServerMessage) {
  switch (message.t) {
    case 'welcome':
      me = message.you
      room = message.room
      unconfirmed = 0
      show('game')
      renderRoom()
      break

    case 'players':
      if (!room) return
      room.players = message.players
      renderRoster()
      break

    case 'state': {
      if (!room || !me) return
      room.count = message.count
      // Our own presses already burst when we pressed; only show the rest.
      for (const team of ['creators', 'destroyers'] as const) {
        let others = message.presses[team]
        if (team === me.team) {
          const ours = Math.min(unconfirmed, others)
          unconfirmed -= ours
          others -= ours
        }
        for (let i = 0; i < Math.min(others, 6); i++) burstPress(team, false)
      }
      break
    }

    case 'phase': {
      if (!room || !me) return
      const previous = room.phase
      Object.assign(room, { phase: message.phase, winner: message.winner, score: message.score, count: message.count })
      unconfirmed = 0
      renderScores()
      if (message.phase !== 'playing' && previous === 'playing' && message.winner) {
        const winner = message.winner
        const over = message.phase === 'gameOver'
        celebrate(winner, over)
        sound.roundOver(winner === me.team)
        const started = performance.now()
        playFlash(over ? GAME_OVER : ROUND_OVER, over ? `${winner} win` : `Point to ${winner}`, onRoundEvent, () => performance.now() - started, () => {})
      }
      break
    }

    case 'track':
      el.trackTitle.textContent = message.track.track
      el.trackArtist.textContent = message.track.artist
      el.music.hidden = screen !== 'game'
      sound.playTrack(message.track, message.elapsedMs)
      break
  }
}

function press() {
  if (screen !== 'game' || !room || !me || room.phase !== 'playing') return
  send({ t: 'press' })
  unconfirmed++
  burstPress(me.team, true)
  sound.press(me.team, shown, true)
  navigator.vibrate?.(8)
}

// --- Rendering the DOM ------------------------------------------------------

function renderRoom() {
  if (!room || !me) return
  el.call.textContent = me.team === 'creators' ? 'create' : 'destroy'
  el.hint.textContent = me.team === 'creators' ? 'Add segment' : 'Remove segment'
  renderRoster()
  renderScores()
}

function renderRoster() {
  if (!room) return
  for (const team of ['creators', 'destroyers'] as const) {
    const list = team === 'creators' ? el.rosterCreators : el.rosterDestroyers
    list.replaceChildren(
      ...room.players
        .filter((player) => player.team === team)
        .map((player) => {
          const p = document.createElement('p')
          p.textContent = player.name
          p.classList.toggle('me', player.id === me?.id)
          p.classList.toggle('bot', !!player.bot)
          return p
        }),
    )
  }
}

function renderScores() {
  if (!room) return
  el.scoreCreators.textContent = String(room.score.creators)
  el.scoreDestroyers.textContent = String(room.score.destroyers)
}

// --- Frame loop -------------------------------------------------------------

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

let last = performance.now()
let lastPercent = ''

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now

  if (flash) flash.player.update(flash.clock())

  // Where the bar should be.
  let target = 1
  if (screen === 'game' && room && me) {
    const optimistic = room.phase === 'playing' ? unconfirmed * (me.team === 'creators' ? 1 : -1) : 0
    target = Math.min(MAX, Math.max(0, room.count + optimistic)) / MAX
  } else if (screen === 'intro') {
    target = START / MAX
  }
  shown += (target - shown) * (1 - Math.exp(-dt * 22))

  if (screen === 'game') {
    const percent = `${Math.round(shown * 100)}%`
    if (percent !== lastPercent) el.percent.textContent = lastPercent = percent
  }

  // Calm down.
  const decay = Math.exp(-dt * 7)
  pulse = { creators: pulse.creators * decay, destroyers: pulse.destroyers * decay }
  trauma = Math.max(0, trauma - dt * 1.4)
  spike *= Math.exp(-dt * 5)
  pressRate *= Math.exp(-dt * 1.5)

  const edge = screen === 'game' ? Math.max(smoothstep(0.7, 0.96, shown), smoothstep(0.3, 0.04, shown)) : 0
  const chaos = Math.min(1, Math.max(spike, smoothstep(2, 22, pressRate) * 0.75 + edge * 0.45 + trauma * 0.3))

  // Shake and split the DOM along with the canvas.
  const shake = trauma * trauma * (touch ? 9 : 16)
  el.root.style.setProperty('--shake-x', `${((Math.random() * 2 - 1) * shake).toFixed(1)}px`)
  el.root.style.setProperty('--shake-y', `${((Math.random() * 2 - 1) * shake).toFixed(1)}px`)
  el.root.style.setProperty('--split', `${(chaos * 5 + trauma * 6).toFixed(1)}px`)

  if (stage) {
    const u = stage.uniforms
    u.frame.value.set(frameRect.x, frameRect.y, frameRect.w, frameRect.h)
    u.bar.value.set(barRect.x, barRect.y, barRect.w, barRect.h)
    u.progress.value = shown
    u.boundary.value = screen === 'game' ? Math.min(0.8, Math.max(0.2, 1 - shown)) : 0.5
    u.chaos.value = chaos
    u.dangerCreators.value = screen === 'game' ? smoothstep(0.3, 0.03, shown) : 0
    u.dangerDestroyers.value = screen === 'game' ? smoothstep(0.7, 0.97, shown) : 0
    u.pulseCreators.value = pulse.creators
    u.pulseDestroyers.value = pulse.destroyers
    u.shock.value.set(shockOrigin.x, shockOrigin.y, (now - shockAt) / 1000, shockStrength)
    u.beat.value = sound.beat()

    const covering = screen === 'intro' || !!flash
    u.flash.value = covering ? 1 : 0
    u.strobe.value = flash?.player.dark ? 1 : 0
    stage.fringe.value = 0.0005 + chaos * 0.005 + trauma * 0.006

    // A slow drizzle of sparks off the bar on the name screen.
    if (screen === 'name' && Math.random() < dt * 6) {
      stage.particles.emit({ x: barRect.x + Math.random() * barRect.w, y: barRect.y + barRect.h / 2, count: 6, kind: Kind.Spark, speed: 160, angle: -Math.PI / 2, spread: 2, height: 30, life: 1.4, size: 7 })
    }

    stage.render(dt)
  }

  requestAnimationFrame(frame)
}

// --- Input ------------------------------------------------------------------

function onGesture() {
  if (screen !== 'intro') return false
  if (!introStarted) startIntro()
  else if (performance.now() - introStartedAt > 1200) skipIntro()
  return true
}

window.addEventListener('keydown', (event: KeyboardEvent) => {
  if (onGesture()) return
  if (event.code === 'Space' && !event.repeat && screen === 'game') {
    event.preventDefault()
    press()
  }
})

el.stage.addEventListener('pointerdown', (event) => {
  if (onGesture()) return
  if ((event.target as HTMLElement).closest('button, input')) return
  if (screen === 'game') {
    event.preventDefault()
    press()
  }
})

el.join.addEventListener('submit', (event) => {
  event.preventDefault()
  const name = el.name.value.trim()
  if (!name) return
  localStorage.setItem('clicky-name', name)
  el.name.blur()
  sound.unlock()
  connect(name)
  void requestWakeLock()
})

el.mute.setAttribute('aria-pressed', String(sound.muted))
el.mute.addEventListener('click', () => {
  sound.muted = !sound.muted
  el.mute.setAttribute('aria-pressed', String(sound.muted))
})
el.skip.addEventListener('click', () => send({ t: 'skip' }))

/** Keep a phone's screen on while it's being mashed. */
async function requestWakeLock() {
  try {
    await navigator.wakeLock?.request('screen')
  } catch {}
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && screen === 'game') void requestWakeLock()
})

// --- Start ------------------------------------------------------------------

el.control.textContent = touch ? 'Tap' : 'Spacebar'
el.flash.hidden = false
el.flashPrompt.textContent = touch ? 'Tap to start' : 'Press any key'
show('intro')

try {
  stage = new Stage(el.canvas)
  await stage.init()
  el.root.dataset.backend = stage.backend
} catch (error) {
  console.error('Effects unavailable', error)
  stage = null
  el.root.classList.add('no-fx')
}
measure()
requestAnimationFrame(frame)
