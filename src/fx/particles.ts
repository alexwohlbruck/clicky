import { AdditiveBlending, type ComputeNode, NormalBlending, Sprite, SpriteNodeMaterial, Vector2, Vector4 } from 'three/webgpu'
import {
  Fn,
  If,
  cos,
  float,
  hash,
  instanceIndex,
  instancedArray,
  mix,
  mod,
  select,
  sin,
  step,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl'
import { PALETTE } from './palette'

/** Particles live in a ring buffer on the GPU; a burst claims the next run of slots. */
const COUNT = 16384
/** Bursts that can start in one frame. Extra ones wait for the next frame. */
const BURSTS = 8

export enum Kind {
  /** Creator presses: hot pink and blue sparks that glow. */
  Spark = 0,
  /** Destroyer presses: chunks that break off and fall. */
  Debris = 1,
  /** A round won by the creators. */
  ConfettiCreators = 2,
  /** A round won by the destroyers. */
  ConfettiDestroyers = 3,
  /** The intro: shards thrown off each letter. */
  Shard = 4,
}

export interface Burst {
  x: number
  y: number
  count: number
  kind: Kind
  /** Pixels per second. */
  speed: number
  /** Direction in radians, screen space with y pointing down. */
  angle?: number
  /** Width of the cone around `angle`, in radians. A full circle is 2π. */
  spread?: number
  /** Spawn area around (x, y), in pixels. */
  width?: number
  height?: number
  life?: number
  size?: number
}

export class Particles {
  readonly objects: Sprite[]
  /** Run once before the first frame: marks every particle dead. */
  readonly init: ComputeNode
  /** Run every frame: spawns this frame's bursts and moves everything. */
  readonly update: ComputeNode

  private cursor = 0
  private queue: Burst[] = []
  private dt = uniform(0)
  private seed = uniform(0)
  private res = uniform(new Vector2(1, 1))
  /** Per burst: position, ring start and count. */
  private slots = Array.from({ length: BURSTS }, () => ({
    at: uniform(new Vector4(0, 0, 0, 0)),
    /** kind, speed, angle, spread */
    motion: uniform(new Vector4()),
    /** width, height, life, size */
    shape: uniform(new Vector4()),
  }))

  constructor() {
    const posLife = instancedArray(COUNT, 'vec4') // x, y, age, lifetime
    const velSize = instancedArray(COUNT, 'vec4') // vx, vy, size, kind
    const tint = instancedArray(COUNT, 'vec4') // r, g, b, spin

    // Everything starts dead: age past lifetime.
    this.init = Fn(() => {
      posLife.element(instanceIndex).assign(vec4(0, 0, 1, 0))
    })().compute(COUNT)

    this.update = Fn(() => {
      const p = posLife.element(instanceIndex)
      const v = velSize.element(instanceIndex)
      const c = tint.element(instanceIndex)
      const index = float(instanceIndex)

      for (const slot of this.slots) {
        const rel = mod(index.sub(slot.at.z).add(COUNT), COUNT)
        If(rel.lessThan(slot.at.w), () => {
          const s = index.add(this.seed.mul(9973))
          const h1 = hash(s)
          const h2 = hash(s.add(17011))
          const h3 = hash(s.add(29983))
          const h4 = hash(s.add(41017))
          const h5 = hash(s.add(53003))

          const kind = slot.motion.x
          const angle = slot.motion.z.add(h1.sub(0.5).mul(slot.motion.w))
          const speed = slot.motion.y.mul(h2.mul(h2).mul(0.85).add(0.15))
          const life = slot.shape.z.mul(h3.mul(0.6).add(0.7))

          p.assign(
            vec4(
              slot.at.x.add(h4.sub(0.5).mul(slot.shape.x)),
              slot.at.y.add(h5.sub(0.5).mul(slot.shape.y)),
              0,
              life,
            ),
          )
          v.assign(vec4(cos(angle).mul(speed), sin(angle).mul(speed), slot.shape.w.mul(h4.mul(0.7).add(0.5)), kind))
          c.assign(vec4(palette(kind, h5, h3), h1.sub(0.5).mul(24)))
        })
      }

      If(p.z.lessThan(p.w), () => {
        const kind = v.w
        // Sparks hang in the air, debris drops, confetti drifts down.
        const gravity = select(kind.lessThan(0.5), 160, select(kind.lessThan(1.5), 1900, select(kind.lessThan(3.5), 420, 900)))
        const drag = select(kind.lessThan(0.5), 3.2, select(kind.lessThan(1.5), 0.6, select(kind.lessThan(3.5), 2.4, 1.2)))
        const flutter = step(1.5, kind).mul(step(kind, 3.5)).mul(sin(p.z.mul(9).add(c.w)).mul(900))

        const vx = v.x.add(flutter.mul(this.dt)).mul(float(1).sub(drag.mul(this.dt)))
        const vy = v.y.add(gravity.mul(this.dt)).mul(float(1).sub(drag.mul(this.dt)))
        v.assign(vec4(vx, vy, v.z, v.w))
        p.assign(vec4(p.x.add(vx.mul(this.dt)), p.y.add(vy.mul(this.dt)), p.z.add(this.dt), p.w))
      })
    })().compute(COUNT)

    const pl = posLife.toAttribute()
    const vs = velSize.toAttribute()
    const tc = tint.toAttribute()
    const age = pl.z.div(pl.w.max(0.0001))
    const alive = step(pl.z, pl.w)

    const material = (glow: boolean) => {
      const m = new SpriteNodeMaterial({ transparent: true, depthWrite: false, depthTest: false })
      m.blending = glow ? AdditiveBlending : NormalBlending
      const ofKind = glow ? step(vs.w, 0.5) : step(0.5, vs.w)
      const fade = float(1).sub(age.mul(age))
      m.positionNode = vec3(pl.x, this.res.y.sub(pl.y), 0)
      m.scaleNode = vs.z.mul(alive).mul(ofKind).mul(glow ? fade.add(0.3) : 1)
      m.rotationNode = tc.w.mul(pl.z)

      if (glow) {
        const d = uv().sub(0.5).length().mul(2)
        const disc = float(1).sub(d).clamp(0, 1).pow(1.6)
        m.colorNode = vec4(tc.xyz.mul(disc).mul(fade), 1)
      } else {
        m.colorNode = vec4(tc.xyz, fade.pow(0.5))
      }
      return m
    }

    this.objects = [new Sprite(material(false)), new Sprite(material(true))]
    for (const sprite of this.objects) {
      sprite.count = COUNT
      sprite.frustumCulled = false
    }
  }

  resize(width: number, height: number) {
    this.res.value.set(width, height)
  }

  emit(burst: Burst) {
    if (burst.count > 0) this.queue.push(burst)
  }

  /** Load this frame's bursts into the compute shader. */
  step(dt: number) {
    this.dt.value = Math.min(dt, 1 / 20)
    this.seed.value = (this.seed.value + 1) % 1000

    for (const slot of this.slots) {
      const burst = this.queue.shift()
      if (!burst) {
        slot.at.value.w = 0
        continue
      }
      const count = Math.min(Math.round(burst.count), COUNT)
      slot.at.value.set(burst.x, burst.y, this.cursor, count)
      slot.motion.value.set(burst.kind, burst.speed, burst.angle ?? 0, burst.spread ?? Math.PI * 2)
      slot.shape.value.set(burst.width ?? 0, burst.height ?? 0, burst.life ?? 1, burst.size ?? 1)
      this.cursor = (this.cursor + count) % COUNT
    }
  }
}

/** Colour for a new particle. `pick` chooses within the kind's palette. */
function palette(kind: any, pick: any, glow: any) {
  const { pink, blue, white, charcoal, dark } = PALETTE
  // Spark colours are pushed past 1 so they bloom.
  const spark = mix(mix(pink, blue, step(0.55, pick)), white, step(0.85, pick)).mul(glow.mul(1.5).add(1.6))
  const debris = mix(mix(charcoal, dark, step(0.5, pick)), white, step(0.82, pick))
  const confettiC = mix(mix(blue, pink, step(0.45, pick)), white, step(0.8, pick))
  const confettiD = mix(mix(charcoal, pink, step(0.5, pick)), white, step(0.75, pick))
  const shard = mix(pink, dark, step(0.6, pick))

  return select(
    kind.lessThan(0.5),
    spark,
    select(kind.lessThan(1.5), debris, select(kind.lessThan(2.5), confettiC, select(kind.lessThan(3.5), confettiD, shard))),
  )
}
