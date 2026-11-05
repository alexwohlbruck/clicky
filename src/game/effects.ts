import { nextBeat } from '../../shared/music'
import { MAX, START, TEAM_NAME, type Team } from '../../shared/protocol'
import { Sound } from '../audio'
import { Flash, GAME_OVER, INTRO, ROUND_OVER, cues, introIntensity, type FlashEvent, type Frames } from '../flash'
import { Kind } from '../fx/particles'
import { Stage } from '../fx/stage'
import { haptics } from '../haptics'
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
/** Your last press: where on the bar (0 to 1), when, and how long the streak is. */
let myPress = { at: 0.5, time: -Infinity, team: 'creators' as Team, streak: 0 }
let wasOnFire = false
let nextHeartbeat = 0
/** How close your side is to losing, 0 to 1. */
let danger = 0

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
  if (mine) mark(team)
}

/** Your own press: a sound, a tap, a chip off the tip, and a notch in the bar. */
function mark(team: Team) {
  const now = performance.now()
  const streak = now - myPress.time < 450 ? myPress.streak + 1 : 1
  // Where the bar is headed, not where it's drawn: the drawing eases after it.
  const at = target()
  myPress = { at, time: now, team, streak }
  const milestone = streak % 10 === 0

  sound.press(team, shown, true)
  haptics.press(milestone)
  if (milestone) sound.combo(streak / 10)
  const fire = onFire()
  if (fire && !wasOnFire) sound.onFire()
  wasOnFire = fire

  const x = barRect.x + barRect.w * at
  const sign = team === 'creators' ? '+' : '−'
  pop(x, barRect.y, milestone ? `${streak} combo` : `${sign}1`, team, milestone)
}

// A small pool of chips, recycled, so mashing never creates DOM nodes.
const chips: HTMLElement[] = []
let nextChip = 0
function pop(x: number, y: number, text: string, team: Team, big: boolean) {
  const layer = $('chips')
  if (!layer) return
  if (chips.length < 24) {
    const el = document.createElement('span')
    layer.append(el)
    chips.push(el)
  }
  const el = chips[nextChip++ % chips.length]!
  el.textContent = text
  el.className = `chip-pop ${team}${big ? ' big' : ''}`
  // A little sideways scatter so a mash fans out instead of stacking.
  const from = x + (Math.random() - 0.5) * 30
  const to = from + (Math.random() - 0.5) * 60
  const at = (dx: number, dy: number, scale: number) => `translate(${dx}px, ${y + dy}px) translate(-50%, -100%) scale(${scale})`
  el.getAnimations().forEach((a) => a.cancel())
  el.animate(
    [
      { transform: at(from, 12, 0.4), opacity: 0 },
      { transform: at(from, -6, 1.1), opacity: 1, offset: 0.15 },
      { transform: at(to, big ? -90 : -64, 0.9), opacity: 0 },
    ],
    { duration: big ? 1100 : 700, easing: 'cubic-bezier(0.2, 0.8, 0.3, 1)', fill: 'forwards' },
  )
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
  if (state.me) (winner === state.me.team ? haptics.won : haptics.lost)()
  myPress.streak = 0

  const frames = gameOver ? GAME_OVER : ROUND_OVER
  const text = gameOver ? `${TEAM_NAME[winner]} win` : `Point to ${TEAM_NAME[winner]}`
  // The score is scheduled up front against the same timeline the flash plays.
  sound.score(cues(frames, text), !state.me ? 'neutral' : winner === state.me.team ? 'won' : 'lost', gameOver)
  // The song cuts dead on the hit. After a round it comes back muffled once
  // the flash has played (see \`waiting\`); after a game, in full for the lobby.
  sound.cutSong()
  const started = performance.now()
  playFlash(frames, text, onRoundEvent, () => performance.now() - started, () => {
    if (gameOver) sound.openSong()
  })
}

/**
 * When play starts, by the server's clock, nudged onto this player's own
 * nearest beat: the server times it to the song, but each player hears the
 * song a little early or late depending on their connection.
 */
function onBeat(delay: number) {
  const analysis = sound.analysis
  const ms = sound.musicMs()
  if (!analysis || ms === null) return delay
  const target = ms + delay * 1000
  const beat = nextBeat(analysis, target - 150)
  return beat && Math.abs(beat.at - target) <= 150 ? Math.max(0, delay + (beat.at - target) / 1000) : delay
}

/** Play resumes after a round: the song opens up and GO hits, on the beat. */
hooks.waiting = (endsInMs) => {
  const at = onBeat(endsInMs / 1000)
  // Muffled once the flash is over, then open with GO. In that order: each
  // change clears whatever was scheduled after it.
  sound.muffleSong(cues(ROUND_OVER, '').end / 1000)
  sound.go(at)
  sound.openSong(at)
}

hooks.countdown = (endsInMs, tickMs) => {
  trauma = 0.4
  shock(innerWidth / 2, innerHeight / 2, 0.6)
  // The song waits under the countdown, muffled; 3, 2, 1 tick on its beats,
  // and it opens up with GO.
  sound.muffleSong()
  const end = onBeat(endsInMs / 1000)
  for (let i = 0; i < 3; i++) {
    const delay = end - ((3 - i) * tickMs) / 1000
    if (delay < -0.05) continue
    sound.countdownTick(i, Math.max(0, delay))
    setTimeout(haptics.tick, Math.max(0, delay * 1000))
  }
  sound.go(end)
  sound.openSong(end)
}

hooks.go = () => {
  haptics.go()
  const { x, y } = tip()
  shock(x, y, 1)
  trauma = 0.8
  emit({ x, y, count: 400, kind: Kind.Spark, speed: 1800, life: 1, size: 11 })
}

hooks.frenzy = (active) => {
  if (!active) return
  sound.frenzy()
  haptics.frenzy()
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
  if (team === state.me?.team) haptics.surge()
}

hooks.orb = () => sound.shimmer()
hooks.react = () => sound.pop()
hooks.chat = () => sound.chatTick()
hooks.roster = (joined) => sound.roster(joined)

hooks.track = (track, elapsedMs) => sound.playTrack(track, elapsedMs)
hooks.retime = (elapsedMs) => sound.retime(elapsedMs)

// --- The song's beats and drops --------------------------------------------------

sound.onBeat = (index, downbeat) => {
  // Close to losing, the heartbeat lands on the beat: every other beat, then every beat.
  if (danger > 0.05 && (danger > 0.5 || index % 2 === 0)) {
    sound.heartbeat(danger)
    haptics.heartbeat()
  }
  // In play, each bar gives the picture a small kick, more in the loud parts.
  if (downbeat && playing() && state.room?.phase === 'playing') spike = Math.max(spike, 0.25 * sound.energy())
}

sound.onDrop = () => {
  if (state.screen === 'intro' || flash) return
  const inPlay = playing()
  const center = inPlay ? tip() : { x: frameRect.x + frameRect.w / 2, y: frameRect.y + frameRect.h * 0.35 }
  shock(center.x, center.y, inPlay ? 1.1 : 0.8)
  trauma = Math.max(trauma, inPlay ? 0.7 : 0.4)
  spike = Math.max(spike, 0.9)
  emit({ x: center.x, y: center.y, count: inPlay ? 500 : 300, kind: Kind.Spark, speed: 1900, life: 1.2, size: 12 })
}

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

/** Where the bar is headed: the server's count plus our presses it hasn't confirmed yet. */
function target() {
  const { room, me } = state
  if (!playing() || !room) return START / MAX
  const optimistic = me && room.phase === 'playing' ? state.unconfirmed * (me.team === 'creators' ? 1 : -1) : 0
  return Math.min(MAX, Math.max(0, room.count + optimistic)) / MAX
}

/** The bar as drawn: eases toward the target. */
export const display = { progress: 0.5 }

function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000)
  last = now
  measure()

  if (state.screen === 'intro') intensity = flash ? introIntensity(flash.clock()) : 0
  else intensity = 1
  if (flash) flash.player.update(flash.clock())

  const inGame = playing()
  shown += (target() - shown) * (1 - Math.exp(-dt * 22))
  display.progress = shown

  const decay = Math.exp(-dt * 7)
  pulse = { creators: pulse.creators * decay, destroyers: pulse.destroyers * decay }
  trauma = Math.max(0, trauma - dt * 1.4)
  spike *= Math.exp(-dt * 5)
  pressRate *= Math.exp(-dt * 1.5)
  frenzy += ((state.frenzyUntil > now ? 1 : 0) - frenzy) * (1 - Math.exp(-dt * 6))

  // Your side close to losing: a heartbeat you hear and feel, quicker as it gets worse.
  const me = state.me
  const myDanger = inGame && me && state.room?.phase === 'playing' ? (me.team === 'creators' ? smoothstep(0.25, 0.05, shown) : smoothstep(0.75, 0.95, shown)) : 0
  danger = myDanger
  if (!sound.analysis && myDanger > 0.05 && now > nextHeartbeat) {
    sound.heartbeat(myDanger)
    haptics.heartbeat()
    nextHeartbeat = now + 950 - myDanger * 550
  }

  const edge = inGame ? Math.max(smoothstep(0.7, 0.96, shown), smoothstep(0.3, 0.04, shown)) : 0
  const chaos = Math.min(1, Math.max(spike, smoothstep(2, 22, pressRate) * 0.75 + edge * 0.45 + trauma * 0.3 + frenzy * 0.3))

  // One transform on one element, and the split only when it moves, so
  // shaking never makes the browser restyle the page.
  const shake = trauma * trauma * (touch ? 9 : 16)
  const stageEl = $('stage')!
  stageEl.style.transform = shake > 0.05 ? `translate3d(${((Math.random() * 2 - 1) * shake).toFixed(1)}px, ${((Math.random() * 2 - 1) * shake).toFixed(1)}px, 0)` : ''
  const split = (Math.round((chaos * 5 + trauma * 6) * 2) / 2).toFixed(1)
  if (split !== lastSplit) stageEl.style.setProperty('--split', `${(lastSplit = split)}px`)

  // The song's clock runs whether or not there's anything to draw.
  const beat = sound.beat()

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
    u.beat.value = beat
    u.frenzy.value = frenzy
    // The orb fades in where it spawns and out when it's taken.
    orbShown += ((inGame && state.orb !== null ? 1 : 0) - orbShown) * (1 - Math.exp(-dt * 10))
    if (state.orb !== null) u.orb.value.x = state.orb / MAX
    u.orb.value.y = orbShown
    u.flash.value = state.screen === 'intro' || flash ? 1 : 0
    u.strobe.value = flash?.player.dark ? 1 : 0
    stage.fringe.value = (0.0005 + chaos * 0.005 + trauma * 0.006) * intensity
    u.grain.value = intensity
    // Your presses, for the bar: where, how long ago, which side, how hot the streak is.
    const sinceMine = (now - myPress.time) / 1000
    u.mine.value.set(myPress.at, inGame ? sinceMine : 99, myPress.team === 'creators' ? 1 : 0, Math.min(1, myPress.streak / 40) * Math.exp(-Math.max(0, sinceMine - 0.4) * 3))
    menu += ((state.screen === 'intro' || inGame ? 0 : 1) - menu) * (1 - Math.exp(-dt * 5))
    u.menu.value = menu

    // A slow drizzle of sparks off the seam between screens.
    if (!inGame && state.screen !== 'intro' && Math.random() < dt * (1 + 4 * sound.energy() * sound.energy())) {
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
