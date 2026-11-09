/**
 * Taps you can feel. Android has the Vibration API. iOS has none, but toggling
 * a native switch control plays the system's selection haptic (Safari 18+),
 * so a hidden one stands in. That only works inside a tap, which is when a
 * press happens anyway; the rest are Android-only.
 */
const vibrates = 'vibrate' in navigator
const ios = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)

let toggle: HTMLLabelElement | null = null
let lastIosTap = 0

function iosTap() {
  const now = performance.now()
  // The system haptic can't keep up with a 20/s mash; spacing them out keeps each one crisp.
  if (now - lastIosTap < 45) return
  lastIosTap = now
  if (!toggle) {
    toggle = document.createElement('label')
    toggle.ariaHidden = 'true'
    toggle.style.cssText = 'position:fixed;left:-100px;top:0;opacity:0;pointer-events:none'
    const input = document.createElement('input')
    input.type = 'checkbox'
    input.setAttribute('switch', '')
    input.tabIndex = -1
    toggle.append(input)
    document.body.append(toggle)
  }
  toggle.click()
}

function buzz(pattern: number | number[]) {
  if (!haptics.enabled) return
  if (vibrates) navigator.vibrate(pattern)
  else if (ios) iosTap()
}

export const haptics = {
  /** Whether this device can do anything at all. */
  supported: vibrates || ios,

  get enabled() {
    return localStorage.getItem('clicky-haptics') !== '0'
  },
  set enabled(on: boolean) {
    localStorage.setItem('clicky-haptics', on ? '1' : '0')
    if (on) buzz(20)
  },

  /** A press. Every tenth in a streak lands harder. */
  press: (milestone: boolean) => buzz(milestone ? 22 : 7),
  tick: () => buzz(12),
  go: () => buzz(45),
  surge: () => buzz([30, 40, 60]),
  frenzy: () => buzz([18, 30, 18, 30, 18, 30, 40]),
  won: () => buzz([40, 60, 40, 60, 140]),
  lost: () => buzz([220]),
  /** Your side is about to lose: a double thump like a heartbeat. */
  heartbeat: () => buzz([28, 90, 18]),
}
