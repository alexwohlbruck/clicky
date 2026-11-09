import { expect, test } from 'bun:test'
import { Flash, GAME_OVER, INTRO, ROUND_OVER, cues, type FlashEvent, type Frames } from './flash'

const fakeElement = () => ({ textContent: '', style: {} as Record<string, string> }) as unknown as HTMLElement

/** Play the intro at 60 fps and note when each event fired. */
function play(fps = 60) {
  const events: { ms: number; event: FlashEvent }[] = []
  let now = 0
  const flash = new Flash(INTRO, 'clicky', fakeElement(), (event) => events.push({ ms: now, event }))
  for (now = 0; !flash.done && now < 12_000; now += 1000 / fps) flash.update(now)
  return events
}

const NOTE = 159.57
const onNote = (ms: number) => {
  const n = (ms - 353.7) / NOTE
  return Math.abs(n - Math.round(n)) * NOTE
}

test('every letter and size change lands within a frame of a note', () => {
  const events = play()
  const beats = events.filter(({ event }) => event.type === 'letter' || event.type === 'size' || event.type === 'warp')
  expect(beats.length).toBeGreaterThan(15)
  for (const { ms } of beats) expect(onNote(ms)).toBeLessThan(1000 / 60 + 1)
})

test('types "clicky" and ends on the hit after the break', () => {
  const events = play()
  expect(events.filter(({ event }) => event.type === 'letter')).toHaveLength(6)
  const end = events.find(({ event }) => event.type === 'end')!
  expect(end.ms).toBeGreaterThanOrEqual(9667)
  expect(end.ms).toBeLessThan(9667 + 17)
})

test('the slow strobe flips on every other note', () => {
  const toggles = play().filter(({ event }) => event.type === 'toggle' && event.period > 100)
  expect(toggles.length).toBe(8)
  for (const { ms } of toggles) expect(onNote(ms)).toBeLessThan(17)
})

test('a strobe faster than the frame rate flips at most once a frame', () => {
  const toggles = play(30).filter(({ event }) => event.type === 'toggle' && event.period < 100)
  const frames = new Set(toggles.map(({ ms }) => ms))
  expect(frames.size).toBe(toggles.length)
})

test('the letters type out with no effects, and the intensity only climbs from there', async () => {
  const { introIntensity } = await import('./flash')
  const letters = play().filter(({ event }) => event.type === 'letter')
  for (const { ms } of letters) expect(introIntensity(ms)).toBe(0)
  let previous = 0
  for (let ms = 0; ms < 9667; ms += 50) {
    expect(introIntensity(ms)).toBeGreaterThanOrEqual(previous)
    previous = introIntensity(ms)
  }
  expect(introIntensity(8000)).toBe(1)
})

test('the sound cues match what the flash player does', () => {
  for (const [frames, text] of [
    [ROUND_OVER, 'Point to builders'],
    [GAME_OVER, 'destroyers win'],
  ] as [Frames, string][]) {
    const letters: number[] = []
    const toggles: number[] = []
    let end = -1
    let now = 0
    const flash = new Flash(frames, text, fakeElement(), (event) => {
      if (event.type === 'letter') letters.push(now)
      if (event.type === 'toggle') toggles.push(now)
      if (event.type === 'end') end = now
    })
    for (now = 0; !flash.done && now < 10_000; now += 1) flash.update(now)

    const plan = cues(frames, text)
    expect(plan.letters).toEqual(letters)
    expect(plan.end).toBe(end)
    const expected = plan.strobes.flatMap(({ from, to, period }) => Array.from({ length: Math.ceil((to - from) / period) }, (_, i) => from + i * period))
    expect(expected).toEqual(toggles)
  }
})
