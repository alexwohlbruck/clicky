import { Mesh, MeshBasicNodeMaterial, NoToneMapping, OrthographicCamera, PlaneGeometry, RenderPipeline, Scene, WebGPURenderer } from 'three/webgpu'
import { pass, uniform } from 'three/tsl'
import { bloom } from 'three/addons/tsl/display/BloomNode.js'
import { rgbShift } from 'three/addons/tsl/display/RGBShiftNode.js'
import { backgroundNode, backgroundUniforms } from './background'
import { Particles } from './particles'

/**
 * The canvas behind the page: the split background, the bar, the particles,
 * then bloom and colour fringing over the lot. Text stays in the DOM on top.
 */
export class Stage {
  readonly uniforms = backgroundUniforms()
  readonly particles = new Particles()
  /** Colour fringing, in UV units. */
  readonly fringe = uniform(0)
  /** `webgpu` or `webgl2`, whichever three.js managed to start. */
  backend = ''

  private renderer: WebGPURenderer
  private scene = new Scene()
  private camera = new OrthographicCamera(0, 1, 1, 0, -10, 10)
  private background: Mesh
  private pipeline: RenderPipeline

  constructor(private canvas: HTMLCanvasElement) {
    // `?webgl` forces the fallback, for testing it on a machine that has WebGPU.
    const forceWebGL = new URLSearchParams(location.search).has('webgl')
    this.renderer = new WebGPURenderer({ canvas, antialias: false, alpha: false, forceWebGL })
    this.renderer.toneMapping = NoToneMapping
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2))

    const material = new MeshBasicNodeMaterial({ depthWrite: false, depthTest: false })
    material.colorNode = backgroundNode(this.uniforms)
    this.background = new Mesh(new PlaneGeometry(1, 1), material)
    this.background.frustumCulled = false
    this.background.renderOrder = -1
    this.scene.add(this.background, ...this.particles.objects)

    const scenePass = pass(this.scene, this.camera)
    const color = scenePass.getTextureNode()
    // Only colours pushed past white (spark cores, the bar tip) bloom.
    const glow = bloom(color, 0.9, 0.35, 1.0)
    this.pipeline = new RenderPipeline(this.renderer)
    this.pipeline.outputNode = rgbShift(color.add(glow), this.fringe)
  }

  async init() {
    await this.renderer.init()
    this.backend = (this.renderer.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend ? 'webgpu' : 'webgl2'
    this.renderer.compute(this.particles.init)
    this.resize()
  }

  resize() {
    const width = window.innerWidth
    const height = window.innerHeight
    this.renderer.setSize(width, height, false)
    this.uniforms.res.value.set(width, height)
    this.particles.resize(width, height)

    // y-up, one unit per CSS pixel.
    Object.assign(this.camera, { left: 0, right: width, top: height, bottom: 0 })
    this.camera.updateProjectionMatrix()
    this.background.scale.set(width, height, 1)
    this.background.position.set(width / 2, height / 2, -1)
  }

  render(dt: number) {
    this.particles.step(dt)
    this.renderer.compute(this.particles.update)
    this.pipeline.render()
  }
}
