/**
 * Pressure on a MacBook trackpad (Force Touch).
 *
 * There is no standard way to read it: `PointerEvent.pressure` always reports
 * 0.5 for a trackpad. The real force is exposed only through non-standard
 * WebKit events, which in practice means Safari on macOS. Everywhere else,
 * mouse and trackpad drawing keeps the pressure simulated from speed — that
 * works in every browser and looks no worse for handwriting.
 */

/** Whether the browser exposes trackpad force events. */
export const FORCE_TOUCH_SUPPORTED =
  typeof document !== 'undefined' && 'onwebkitmouseforcechanged' in document

interface WebKitForceEvent extends MouseEvent {
  webkitForce: number
}

/**
 * Maps WebKit force onto our 0…1 pressure.
 *
 * WebKit landmarks: about 1 is an ordinary click (`WEBKIT_FORCE_AT_MOUSE_DOWN`),
 * about 2 is a force click (`WEBKIT_FORCE_AT_FORCE_MOUSE_DOWN`), and past 2.5
 * the trackpad is at its ceiling. The lower bound sits just under a normal
 * click so a light touch still leaves a thin but visible line.
 */
export const FORCE_MIN = 0.55
export const FORCE_MAX = 2.6

export function forceToPressure(force: number): number {
  if (!Number.isFinite(force)) return 0.5
  const t = (force - FORCE_MIN) / (FORCE_MAX - FORCE_MIN)
  return Math.min(1, Math.max(0.05, t))
}

/**
 * Watches trackpad force and reports every new value.
 * Returns an unsubscribe function.
 *
 * `supported` is a parameter so the behaviour can be tested without Safari.
 */
export function trackForceTouch(
  target: HTMLElement,
  onForce: (pressure: number) => void,
  supported: boolean = FORCE_TOUCH_SUPPORTED,
): () => void {
  if (!supported) return () => {}

  const onChanged = (e: Event) => {
    onForce(forceToPressure((e as WebKitForceEvent).webkitForce))
  }
  // Without this a firm press triggers the system force click: dictionary,
  // Quick Look and a haptic thump in the middle of a stroke.
  const onWillBegin = (e: Event) => e.preventDefault()

  target.addEventListener('webkitmouseforcewillbegin', onWillBegin)
  target.addEventListener('webkitmouseforcechanged', onChanged)
  target.addEventListener('webkitmouseforcedown', onChanged)
  target.addEventListener('webkitmouseforceup', onChanged)

  return () => {
    target.removeEventListener('webkitmouseforcewillbegin', onWillBegin)
    target.removeEventListener('webkitmouseforcechanged', onChanged)
    target.removeEventListener('webkitmouseforcedown', onChanged)
    target.removeEventListener('webkitmouseforceup', onChanged)
  }
}
