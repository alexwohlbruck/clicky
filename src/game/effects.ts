import { MAX, START, type Team } from '../../shared/protocol'
import { Sound } from '../audio'
import { Flash, GAME_OVER, INTRO, ROUND_OVER, introIntensity, type FlashEvent, type Frames } from '../flash'
import { Kind } from '../fx/particles'
import { Stage } from '../fx/stage'
import { hooks, state } from './store'

/**
 * The frame loop: drives the WebGPU stage from the game state, and plays the
 * flash sequences. The Vue components only mark where things are with ids
 * (`#frame`, `#bar`) and this reads their positions.
 */
export const sound = new Sound()
let stage: Stage | null = null

const touch = matchMedia('(pointer: coarse)').matches

let shown = 0.5
let trauma = 0
let pulse = { creators: 0, destroyers: 0 }
let pressRate = 0
let spike = 0
let shockAt = -Infinity
let shockStrength = 0
let shockOrigin = { x: 0, y: 0 }
let frenzy = 0
let intensity = 1
let orbShown = 0

let flash: { player: Flash; clock: () => number } | null = null
let introStarted = false
let introStartedAt = 0

let frameRect = { x: 0, y: 0, w: 1, h: 1 }
let barRect = { x: 0, y: -100, w: 1, h: 0 }

const $ = (id: string) => document.getElementById(id)

const playing = () => state.screen === 'room' && !!state.room && state.room.phase !== 'lobby'

function measure() {
  const frame = $('frame')
  if (frame) {
    const r = frame.getBoundingClientRect()
    frameRect = { x: r.x, y: r.y, w: r.width, h: r.height }
  }
  const bar = $('bar')
  if (bar && playing()) {
    const r = bar.getBoundingClientRect()
    barRect = { x: frameRect.x, y: r.y, w: frameRect.w, h: r.height }
  } else {
    barRect = { x: frameRect.x, y: -100, w: frameRect.w, h: 0 }
  }
  document.documentElement.style.setProperty('--flash-scale', String(Math.min(1, innerWidth / 1500, innerHeight / 700)))
}

/** Ten presses in the last second. */
export const onFire = () => {
  const now = performance.now()
  return state.myRecent.filter((at) => now - at < 1000).length >= 10
}

const tip = () => ({ x: barRect.x + barRect.w * shown, y: barRect.y + barRect.h / 2 })

function shock(x: number, y: number, strength: number) {
  shockAt = performance.now()
  shockStrength = strength
  shockOrigin = { x, y }
}

const emit: Stage['particles']['emit'] = (burst) => stage?.particles.emit(burst)

// --- Game events -------------------------------------------------------------

hooks.press = (team: Team, mine: boolean) => {
  const { x, y } = tip()
  pulse[team] = Math.min(1.5, pulse[team] + (mine ? 0.7 : 0.35))
  trauma = Math.min(1, trauma + (mine ? 0.09 : 0.04))
  pressRate += 1
  // Double time and being on fire both make every press bigger.
  const boost = (frenzy > 0.5 ? 1.8 : 1) * (mine && onFire() ? 1.6 : 1)

  if (team === 'creators') {
    emit({ x, y, count: (mine ? 46 : 18) * boost, kind: Kind.Spark, speed: 900 * boost, angle: 0, spread: Math.PI * 1.7, height: 36, life: 0.75, size: 10 })
  } else {
    emit({ x, y, count: (mine ? 30 : 12) * boost, kind: Kind.Debris, speed: 620 * boost, angle: Math.PI * 1.35, spread: Math.PI * 1.1, height: 40, life: 1.4, size: 11 })
  }
  if (mine) {
    sound.press(team, shown, true)
    navigator.vibrate?.(8)
  }
}

hooks.roundOver = (winner, gameOver) => {
  const { x, y } = tip()
  shock(x, y, 1.2)
  trauma = 1
  spike = 1
  const kind = winner === 'creators' ? Kind.ConfettiCreators : Kind.ConfettiDestroyers
  const columns = gameOver ? 8 : 5
  for (let i = 0; i < columns; i++) {
    emit({ x: frameRect.x + (frameRect.w * (i + 0.5)) / columns, y: -20, count: gameOver ? 260 : 160, kind, speed: 500, angle: Math.PI / 2, spread: 1.2, width: frameRect.w / columns, life: 3.2, size: 13 })
  }
  emit({ x, y, count: 500, kind: Kind.Spark, speed: 1600, life: 1.1, size: 12 })
  sound.roundOver(winner === state.me?.team)

  const started = performance.now()
  playFlash(gameOver ? GAME_OVER : ROUND_OVER, gameOver ? `${winner} win` : `Point to ${winner}`, onRoundEvent, () => performance.now() - started, () => {})
}

hooks.countdown = () => {
  trauma = 0.4
  shock(innerWidth / 2, innerHeight / 2, 0.6)
  // 3, 2, 1 a second apart; GO is played when the round starts.
  for (let i = 0; i < 3; i++) sound.blip(440, 0.15, i)
}

hooks.go = () => {
  sound.blip(880, 0.4)
  const { x, y } = tip()
  shock(x, y, 1)
  trauma = 0.8
  emit({ x, y, count: 400, kind: Kind.Spark, speed: 1800, life: 1, size: 11 })
}

hooks.frenzy = (active) => {
  if (!active) return
  shock(innerWidth / 2, innerHeight / 2, 1.3)
  trauma = 1
  spike = 1
  for (let i = 0; i < 4; i++) emit({ x: Math.random() * innerWidth, y: -20, count: 120, kind: i % 2 ? Kind.ConfettiCreators : Kind.ConfettiDestroyers, speed: 600, angle: Math.PI / 2, spread: 1.4, width: innerWidth / 2, life: 2.4, size: 12 })
}

hooks.surge = (team, at) => {
  const x = barRect.x + (barRect.w * at) / MAX
  const y = barRect.y + barRect.h / 2
  shock(x, y, 1)
  trauma = Math.min(1, trauma + 0.6)
  spike = Math.max(spike, 0.8)
  emit({ x, y, count: 350, kind: Kind.Spark, speed: 1500, life: 1, size: 12 })
  emit({ x, y, count: 120, kind: team === 'creators' ? Kind.ConfettiCreators : Kind.ConfettiDestroyers, speed: 900, angle: -Math.PI / 2, spread: 2.4, life: 1.8, size: 11 })
  sound.coin()
}

hooks.track = (track, elapsedMs) => sound.playTrack(track, elapsedMs)

// --- Flash sequences -----------------------------------------------------------

/** The intro's extra layer: everything the keyframes do also hits the shader. */
function onIntroEvent(event: FlashEvent) {
  const k = event.type === 'end' ? 1 : intensity
  // The opening is plain black and white, as in the original.
  if (k < 0.01) return
  const center = { x: innerWidth / 2, y: innerHeight / 2 }
  const text = $('flash-text')!.getBoundingClientRect()

  switch (event.type) {
    case 'letter':
      shock(text.right, center.y, 0.8 * k)
      trauma = Math.min(1, trauma + 0.45 * k)
      spike = Math.max(spike, 0.6 * k)
      emit({ x: text.right - 20, y: center.y, count: 260 * k, kind: Kind.Shard, speed: 1300, height: text.height * 0.6, life: 1.4, size: 14 })
      break
    case 'size':
      shock(center.x, center.y, 0.6 * k)
      trauma = Math.min(1, trauma + 0.35 * k)
      spike = Math.max(spike, 0.5 * k)
      break
    case 'warp':
      spike = Math.max(spike, k)
      trauma = Math.min(1, trauma + 0.25 * k)
      emit({ x: center.x, y: center.y, count: 120 * k, kind: Kind.Shard, speed: 1700, width: text.width, height: 10, life: 0.8, size: 9 })
      break
    case 'toggle': {
      // The slow strobe pops a ring of shards; the fast one is pure noise.
      const frantic = event.period < 100
      spike = Math.max(spike, (frantic ? 1 : 0.55) * k)
      if (frantic) {
        emit({ x: Math.random() * innerWidth, y: Math.random() * innerHeight, count: 40 * k, kind: Kind.Shard, speed: 1100, life: 0.6, size: 10 })
      } else {
        shock(center.x, center.y, 0.5 * k)
        emit({ x: center.x, y: center.y, count: 180 * k, kind: Kind.Shard, speed: 1500, life: 1.2, size: 12 })
      }
      break
    }
    case 'end':
      shock(center.x, center.y, 1.4)
      trauma = 1
      emit({ x: center.x, y: center.y, count: 900, kind: Kind.Spark, speed: 2200, life: 1.4, size: 12 })
      break
  }
}

function onRoundEvent(event: FlashEvent) {
  if (event.type === 'letter') {
    trauma = Math.min(1, trauma + 0.2)
    const text = $('flash-text')!.getBoundingClientRect()
    emit({ x: text.right - 10, y: text.y + text.height / 2, count: 60, kind: Kind.Shard, speed: 900, height: text.height * 0.5, life: 1, size: 10 })
  }
  if (event.type === 'toggle') spike = Math.max(spike, 0.4)
}

function playFlash(frames: Frames, text: string, onEvent: (event: FlashEvent) => void, clock: () => number, onEnd: () => void) {
  const overlay = $('flash')!
  overlay.hidden = false
  document.body.dataset.flashing = ''
  const player = new Flash(frames, text, $('flash-text')!, (event) => {
    onEvent(event)
    if (event.type === 'end') {
      flash = null
      overlay.hidden = true
      delete document.body.dataset.flashing
      onEnd()
    }
  })
  flash = { player, clock }
}

async function startIntro() {
  introStarted = true
  introStartedAt = performance.now()
  sound.unlock()
  $('flash-prompt')?.remove()
  $('flash-warning')?.remove()

  let clock: () => number
  try {
    clock = await sound.playIntro()
  } catch (error) {
    console.warn('Intro music unavailable', error)
    const started = performance.now()
    clock = () => performance.now() - started
  }
  playFlash(INTRO, 'clicky', onIntroEvent, clock, () => (state.screen = 'home'))
}

/** Any key or tap starts the intro; another one skips it. */
export function introGesture() {
  if (state.screen !== 'intro') return false
  if (!introStarted) void startIntro()
  else if (performance.now() - introStartedAt > 1200) flash?.player.update(Number.MAX_SAFE_INTEGER)
  return true
}

// --- Frame loop ----------------------------------------------------------------

const smoothstep = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)))
  return t * t * (3 - 2 * t)
}

let last = performance.now()
let menu = 0
let lastSplit = ''

/** The bar as drawn: eases toward the server's count plus our unconfirmed presses. */
export const display = { progress: 0.5 }

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  measure()

  if (state.screen === 'intro') intensity = flash ? introIntensity(flash.clock()) : 0
  else intensity = 1
  if (flash) flash.player.update(flash.clock())

  const inGame = playing()
  let target = START / MAX
  if (inGame && state.room) {
    const optimistic = state.me && state.room.phase === 'playing' ? state.unconfirmed * (state.me.team === 'creators' ? 1 : -1) : 0
    target = Math.min(MAX, Math.max(0, state.room.count + optimistic)) / MAX
  }
  shown += (target - shown) * (1 - Math.exp(-dt * 22))
  display.progress = shown

  const decay = Math.exp(-dt * 7)
  pulse = { creators: pulse.creators * decay, destroyers: pulse.destroyers * decay }
  trauma = Math.max(0, trauma - dt * 1.4)
  spike *= Math.exp(-dt * 5)
  pressRate *= Math.exp(-dt * 1.5)
  frenzy += ((state.frenzyUntil > now ? 1 : 0) - frenzy) * (1 - Math.exp(-dt * 6))

  const edge = inGame ? Math.max(smoothstep(0.7, 0.96, shown), smoothstep(0.3, 0.04, shown)) : 0
  const chaos = Math.min(1, Math.max(spike, smoothstep(2, 22, pressRate) * 0.75 + edge * 0.45 + trauma * 0.3 + frenzy * 0.3))

  // One transform on one element, and the split only when it moves, so
  // shaking never makes the browser restyle the page.
  const shake = trauma * trauma * (touch ? 9 : 16)
  const stageEl = $('stage')!
  stageEl.style.transform = shake > 0.05 ? `translate3d(${((Math.random() * 2 - 1) * shake).toFixed(1)}px, ${((Math.random() * 2 - 1) * shake).toFixed(1)}px, 0)` : ''
  const split = (Math.round((chaos * 5 + trauma * 6) * 2) / 2).toFixed(1)
  if (split !== lastSplit) stageEl.style.setProperty('--split', `${(lastSplit = split)}px`)

  if (stage) {
    const u = stage.uniforms
    u.frame.value.set(frameRect.x, frameRect.y, frameRect.w, frameRect.h)
    u.bar.value.set(barRect.x, barRect.y, barRect.w, barRect.h)
    u.progress.value = shown
    // Outside a game the halves drift back and forth on their own.
    u.boundary.value = inGame ? Math.min(0.8, Math.max(0.2, 1 - shown)) : 0.5 + Math.sin(now / 2400) * 0.06
    u.chaos.value = chaos
    u.dangerCreators.value = inGame ? smoothstep(0.3, 0.03, shown) : 0
    u.dangerDestroyers.value = inGame ? smoothstep(0.7, 0.97, shown) : 0
    u.pulseCreators.value = pulse.creators
    u.pulseDestroyers.value = pulse.destroyers
    u.shock.value.set(shockOrigin.x, shockOrigin.y, (now - shockAt) / 1000, shockStrength)
    u.beat.value = sound.beat()
    u.frenzy.value = frenzy
    // The orb fades in where it spawns and out when it's taken.
    orbShown += ((inGame && state.orb !== null ? 1 : 0) - orbShown) * (1 - Math.exp(-dt * 10))
    if (state.orb !== null) u.orb.value.x = state.orb / MAX
    u.orb.value.y = orbShown
    u.flash.value = state.screen === 'intro' || flash ? 1 : 0
    u.strobe.value = flash?.player.dark ? 1 : 0
    stage.fringe.value = (0.0005 + chaos * 0.005 + trauma * 0.006) * intensity
    u.grain.value = intensity
    menu += ((state.screen === 'intro' || inGame ? 0 : 1) - menu) * (1 - Math.exp(-dt * 5))
    u.menu.value = menu

    // A slow drizzle of sparks off the seam between screens.
    if (!inGame && state.screen !== 'intro' && Math.random() < dt * 2) {
      emit({ x: frameRect.x + frameRect.w * u.boundary.value, y: frameRect.y + Math.random() * frameRect.h, count: 5, kind: Kind.Spark, speed: 140, angle: -Math.PI / 2, spread: 2.5, height: 20, life: 1.6, size: 7 })
    }

    stage.render(dt)
  }

  requestAnimationFrame(frame)
}

export async function startEffects(canvas: HTMLCanvasElement) {
  try {
    stage = new Stage(canvas)
    await stage.init()
    document.documentElement.dataset.backend = stage.backend
  } catch (error) {
    console.error('Effects unavailable', error)
    stage = null
    document.documentElement.classList.add('no-fx')
  }
  addEventListener('resize', () => stage?.resize())
  requestAnimationFrame(frame)
}
