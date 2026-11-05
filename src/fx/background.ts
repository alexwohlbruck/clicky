import { Vector2, Vector4 } from 'three/webgpu'
import {
  Fn,
  abs,
  exp,
  float,
  floor,
  fract,
  hash,
  max,
  mix,
  mx_noise_float,
  screenUV,
  sin,
  smoothstep,
  step,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { PALETTE } from './palette'

/**
 * Everything the background shader reads. Rectangles are CSS pixels measured
 * from the DOM, with y pointing down, so the layout stays in the stylesheet.
 */
export function backgroundUniforms() {
  return {
    res: uniform(new Vector2(1, 1)),
    /** The playing field inside the frame border: x, y, width, height. */
    frame: uniform(new Vector4()),
    /** The white band the bar sits in. */
    bar: uniform(new Vector4()),
    /** Bar fill, 0 to 1. */
    progress: uniform(0.5),
    /** Where the charcoal half meets the blue half, 0 to 1 across the frame. */
    boundary: uniform(0.5),
    /** 0 is calm; 1 is everyone mashing in a close game. */
    chaos: uniform(0),
    /** How close each team is to losing the round. Their half falls apart. */
    dangerCreators: uniform(0),
    dangerDestroyers: uniform(0),
    /** Decaying kicks from recent presses. */
    pulseCreators: uniform(0),
    pulseDestroyers: uniform(0),
    /** Shockwave: x, y, seconds since it started (negative when idle), strength. */
    shock: uniform(new Vector4(0, 0, -1, 0)),
    /** Strobe colour, 0 white or 1 black, and how much it covers the scene. */
    strobe: uniform(0),
    flash: uniform(0),
    /** Low-frequency energy of the music, 0 to 1. */
    beat: uniform(0),
    /** Film grain, 0 to 1. Off while the intro is still plain black and white. */
    grain: uniform(1),
    /** Double time: the halves cycle through a rainbow. */
    frenzy: uniform(0),
    /** Surge orb: position along the bar (0 to 1) and how visible it is. */
    orb: uniform(new Vector2(0.5, 0)),
    /** Menus: the halves sink back so the panels on top read cleanly. */
    menu: uniform(0),
    /** Your last press: where along the bar (0 to 1), seconds since, 1 for creators, streak heat. */
    mine: uniform(new Vector4(0.5, 99, 1, 0)),
  }
}

export type BackgroundUniforms = ReturnType<typeof backgroundUniforms>

const inside = (p: any, rect: any) =>
  step(rect.x, p.x).mul(step(p.x, rect.x.add(rect.z))).mul(step(rect.y, p.y)).mul(step(p.y, rect.y.add(rect.w)))

export function backgroundNode(u: BackgroundUniforms) {
  const { charcoal, blue, dark, pink, white, black } = PALETTE

  return Fn(() => {
    const t = time
    // Wrapped so hash seeds stay inside uint range on long sessions.
    const frameTick = floor(t.mod(600).mul(24))
    const origin = screenUV.mul(u.res)

    // Shockwave: a ring that pushes the picture outwards as it passes.
    const toShock = origin.sub(u.shock.xy)
    const shockDistance = max(toShock.length(), 1)
    const shockRadius = u.shock.z.mul(1600)
    const ring = exp(shockDistance.sub(shockRadius).div(70).pow(2).negate())
      .mul(u.shock.w)
      .mul(step(0, u.shock.z))
      .mul(exp(u.shock.z.mul(-1.8)))
    const shocked = origin.sub(toShock.div(shockDistance).mul(ring).mul(46))

    // Glitch: whole rows slip sideways, more of them the wilder it gets.
    const row = floor(shocked.y.div(14))
    const slip = step(float(1).sub(u.chaos.mul(0.22)), hash(row.add(frameTick.mul(97)).add(5000)))
    const p = vec2(shocked.x.add(hash(row.add(frameTick.mul(31)).add(9000)).sub(0.5).mul(u.chaos).mul(140).mul(slip)), shocked.y)

    // Position inside the playing field.
    const fx = p.x.sub(u.frame.x).div(u.frame.z)
    const inFrame = inside(p, u.frame)

    // The two halves meet at a seam that wobbles, and kicks toward whoever pressed.
    const barMid = u.bar.y.add(u.bar.w.mul(0.5))
    const nearBar = exp(p.y.sub(barMid).div(u.frame.w.mul(0.22)).pow(2).negate())
    const wobble = sin(p.y.mul(0.017).add(t.mul(2.3)))
      .mul(0.005)
      .add(mx_noise_float(vec3(p.y.mul(0.008), t.mul(1.4), 0)).mul(u.chaos.mul(0.03).add(0.004)))
    const seamX = u.boundary.add(wobble).add(nearBar.mul(u.pulseDestroyers.sub(u.pulseCreators)).mul(0.035))
    const isBlue = step(seamX, fx)
    const half = mix(charcoal, blue, isBlue).toVar()

    // A losing half breaks up: blocks flicker and scanlines roll through it.
    const danger = mix(u.dangerDestroyers, u.dangerCreators, isBlue)
    const block = hash(floor(p.x.div(28)).add(floor(p.y.div(28)).mul(131)).add(frameTick.mul(7919)))
    const broken = step(float(0.92).sub(danger.mul(0.5)), block).mul(danger)
    const scan = sin(p.y.mul(0.9).sub(t.mul(30))).mul(0.5).add(0.5)
    half.assign(mix(half, mix(black, white, step(0.5, hash(block.mul(1e4)))), broken.mul(0.55)))
    half.mulAssign(float(1).sub(scan.mul(danger).mul(0.25)))

    // Presses light up their own half near the bar.
    half.addAssign(blue.mul(u.pulseCreators.mul(isBlue).mul(nearBar).mul(0.35)))
    half.mulAssign(float(1).sub(u.pulseDestroyers.mul(isBlue.oneMinus()).mul(nearBar).mul(0.3)))
    half.mulAssign(u.beat.mul(0.08).add(1))
    const rainbow = vec3(0, 0.33, 0.67).add(t.mul(0.9)).add(fx).add(p.y.mul(0.0015)).mul(6.2832).cos().mul(0.5).add(0.5)
    half.assign(mix(half, rainbow, u.frenzy.mul(0.45)))

    // In menus the halves dim toward the frame colour, keeping a hint of each team.
    half.assign(mix(half, mix(dark, half, 0.38), u.menu))

    const seam = exp(abs(fx.sub(seamX)).mul(u.frame.z).div(u.chaos.mul(12).add(2)).negate())
    half.addAssign(white.mul(seam.mul(u.chaos.mul(0.9).add(0.15)).mul(u.menu.mul(-0.5).add(1))))

    // The bar: a white band with the pink fill running to the tip.
    const inBand = inside(p, u.bar)
    const track = vec4(u.bar.x, u.bar.y.add(10), u.bar.z, u.bar.w.sub(20))
    const jitter = hash(floor(p.y.div(4)).add(frameTick.mul(53))).sub(0.5).mul(u.chaos).mul(22)
    const tipX = u.bar.x.add(u.bar.z.mul(u.progress))
    const filled = step(p.x, tipX.add(jitter)).mul(inside(p, track))
    const band = mix(white, pink, filled)

    const scene = mix(half, band, inBand).toVar()


    // The tip burns brightly enough to bloom.
    const tipGlow = exp(abs(p.x.sub(tipX)).div(u.chaos.mul(14).add(5)).negate()).mul(
      exp(max(abs(p.y.sub(barMid)).sub(track.w.mul(0.5)), 0).div(10).negate()),
    )
    scene.addAssign(vec3(1.4, 0.5, 0.8).mul(tipGlow).mul(u.pulseCreators.add(u.pulseDestroyers).mul(1.5).add(0.6)))
    scene.addAssign(white.mul(ring.mul(0.35)))

    // Your presses. The bar is a hundred segments: the dividers around your
    // last press show for a moment (wider on a streak), a notch in your
    // team's colour marks where it landed, and a ripple runs out from it.
    const inTrack = inside(p, track)
    const segment = u.bar.z.div(100)
    const toDivider = abs(fract(p.x.sub(u.bar.x).div(segment).add(0.5)).sub(0.5)).mul(segment)
    const pressX = u.bar.x.add(u.bar.z.mul(u.mine.x))
    const fromPress = abs(p.x.sub(pressX))
    const fresh = exp(u.mine.y.mul(-2.5))
    const nearPress = exp(fromPress.div(u.mine.w.mul(220).add(45)).pow(2).negate())
    // Too fine to read on a narrow screen, so only where segments are wide enough.
    const divider = smoothstep(1.5, 0.5, toDivider).mul(inTrack).mul(smoothstep(4, 7, segment))
    scene.assign(mix(scene, scene.mul(0.6), divider.mul(nearPress).mul(fresh.mul(0.7).add(u.mine.w.mul(0.5)).min(1))))
    const teamColor = mix(dark, blue, u.mine.z)
    const nearBand = step(u.bar.y.sub(16), p.y).mul(step(p.y, u.bar.y.add(u.bar.w).add(16)))
    const notch = smoothstep(4, 2, fromPress).mul(nearBand).mul(fresh)
    scene.assign(mix(scene, teamColor, notch))
    const ripple = exp(fromPress.sub(u.mine.y.mul(800)).div(16).pow(2).negate()).mul(exp(u.mine.y.mul(-6))).mul(inTrack)
    scene.assign(mix(scene, teamColor.mul(1.5), ripple.mul(0.6)))

    // The surge orb: a gold core with a halo that throbs.
    const orbCenter = vec2(u.bar.x.add(u.bar.z.mul(u.orb.x)), barMid)
    const orbDistance = p.sub(orbCenter).length()
    const throb = sin(t.mul(9)).mul(0.5).add(0.5)
    // A dark rim keeps it readable against the white band.
    const orbRim = smoothstep(21, 19, orbDistance)
    const orbCore = smoothstep(17, 15, orbDistance)
    const orbHalo = exp(orbDistance.sub(18).max(0).div(throb.mul(10).add(10)).negate()).mul(orbRim.oneMinus())
    scene.assign(mix(scene, dark, orbRim.mul(u.orb.y)))
    scene.assign(mix(scene, vec3(1, 0.62, 0.05).mul(throb.mul(0.5).add(1)), orbCore.mul(u.orb.y)))
    scene.addAssign(vec3(1, 0.6, 0.1).mul(orbHalo.mul(u.orb.y).mul(0.5)))

    const framed = mix(dark, scene, inFrame).toVar()

    // The strobe (intro and round-over) covers everything, then gets torn up:
    // the shock ring and glitch blocks invert it, slipped rows flash pink.
    const strobe = mix(white, black, u.strobe).toVar()
    const tear = hash(floor(origin.x.div(40)).add(floor(origin.y.div(40)).mul(337)).add(frameTick.mul(4111)))
    const inverted = step(0.25, ring).max(step(float(1).sub(u.chaos.mul(0.12)), tear))
    strobe.assign(mix(strobe, strobe.oneMinus(), inverted))
    strobe.assign(mix(strobe, pink, slip.mul(u.chaos).mul(0.9)))
    framed.assign(mix(framed, strobe, u.flash))

    // Film grain.
    const grain = hash(floor(origin.x).add(floor(origin.y).mul(4099)).add(frameTick.mul(65537))).sub(0.5)
    framed.addAssign(grain.mul(smoothstep(0, 1, u.chaos).mul(0.06).add(0.025)).mul(u.grain))

    return vec4(framed, 1)
  })()
}
