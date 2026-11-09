import { Color } from 'three'
import { uniform } from 'three/tsl'
import { onTheme } from '../theme'

/**
 * The theme's colours as shader uniforms, so the field, the bar and the
 * particles change with it. `Color.set` converts from sRGB to the linear
 * space the shaders mix in.
 */
const live = () => uniform(new Color())

export const PALETTE = {
  creators: live(),
  destroyers: live(),
  bar: live(),
  accent: live(),
  gold: live(),
  frame: live(),
  white: uniform(new Color(0xffffff)),
  black: uniform(new Color(0x000000)),
}

onTheme((theme) => {
  PALETTE.creators.value.set(theme.creators)
  PALETTE.destroyers.value.set(theme.destroyers)
  PALETTE.bar.value.set(theme.bar)
  PALETTE.accent.value.set(theme.accent)
  PALETTE.gold.value.set(theme.gold)
  PALETTE.frame.value.set(theme.frame)
})
