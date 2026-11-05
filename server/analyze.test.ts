import { expect, test } from 'bun:test'
import { ANALYSIS_VERSION, beatIndex, isDownbeat, nextBeat, sectionAt } from '../shared/music'
import { analyze } from './analyze'

/**
 * A made-up track at 120 BPM: sixteen bars of quiet hi-hats, then sixteen of
 * kick and bass, with the first beat of every bar hit harder. Starts 0.25 s in.
 */
function track() {
  const rate = 24000
  const beat = 0.5
  const offset = 0.25
  const bars = 32
  const data = new Float32Array(Math.ceil((offset + bars * 4 * beat + 2) * rate))
  let seed = 1
  const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  for (let i = 0; i < bars * 4; i++) {
    const start = Math.round((offset + i * beat) * rate)
    const loud = i >= 16 * 4
    const accent = i % 4 === 0 ? 1 : 0.6
    for (let n = 0; n < rate * 0.3; n++) {
      const t = n / rate
      let x = 0.06 * accent * noise() * Math.exp(-t * 60)
      if (loud) x += accent * (0.8 * Math.sin(2 * Math.PI * 55 * t) * Math.exp(-t * 12) + 0.3 * noise() * Math.exp(-t * 40))
      data[start + n]! += x
    }
  }
  return { data, rate, offset, beat }
}

test('finds the tempo, beats, downbeats and the drop in a synthetic track', () => {
  const { data, rate, offset, beat } = track()
  const analysis = analyze([data], rate)

  expect(analysis.bpm).toBeGreaterThan(118)
  expect(analysis.bpm).toBeLessThan(122)

  // Every beat within 25 ms of where it was put, most within 12: tighter than ears can tell.
  const errors = analysis.beats.map((at) => Math.abs(at / 1000 - (offset + Math.round((at / 1000 - offset) / beat) * beat)))
  expect(Math.max(...errors)).toBeLessThan(0.025)
  expect([...errors].sort((a, b) => a - b)[errors.length >> 1]!).toBeLessThan(0.012)
  expect(analysis.beats.length).toBeGreaterThan(120)

  // Downbeats are the accented beats: the first of each bar.
  const first = analysis.beats.find((_, i) => isDownbeat(analysis, i))!
  expect(Math.round((first / 1000 - offset) / beat) % 4).toBe(0)

  // The drop is where the kick comes in, sixteen bars in.
  const dropAt = (offset + 16 * 4 * beat) * 1000
  expect(analysis.drops.some((drop) => Math.abs(drop - dropAt) < 60)).toBe(true)
  expect(sectionAt(analysis, dropAt - 4000)!.energy).toBeLessThan(sectionAt(analysis, dropAt + 4000)!.energy)
})

test('beat queries', () => {
  const analysis = { version: ANALYSIS_VERSION, bpm: 120, beats: [0, 500, 1000, 1500, 2000, 2500], downbeat: 1, sections: [], drops: [] }
  expect(beatIndex(analysis, -1)).toBe(-1)
  expect(beatIndex(analysis, 1200)).toBe(2)
  expect(nextBeat(analysis, 1200)).toEqual({ index: 3, at: 1500 })
  expect(nextBeat(analysis, 1500)).toEqual({ index: 3, at: 1500 })
  expect(nextBeat(analysis, 600, true)).toEqual({ index: 5, at: 2500 })
  expect(nextBeat(analysis, 2600)).toBeNull()
})
