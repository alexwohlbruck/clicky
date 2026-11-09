import { color } from 'three/tsl'

/** The original Clicky colours. `color()` converts them to linear space for mixing. */
export const HEX = {
  charcoal: 0x37474f,
  blue: 0x0091ea,
  dark: 0x1f282d,
  pink: 0xe91e63,
  white: 0xffffff,
  black: 0x000000,
} as const

export const PALETTE = {
  charcoal: color(HEX.charcoal),
  blue: color(HEX.blue),
  dark: color(HEX.dark),
  pink: color(HEX.pink),
  white: color(HEX.white),
  black: color(HEX.black),
}
