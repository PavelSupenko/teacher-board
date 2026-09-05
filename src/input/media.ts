import { nanoid } from 'nanoid'
import { BOARD_H, BOARD_W } from '../model/types'
import { t } from '../i18n'
import type { ImageElement } from '../model/types'

/** Longest side an inserted image is scaled down to. */
export const MAX_IMAGE_SIDE = 1600
/** Cap for the data URL: the document travels whole, so it must stay lean. */
export const MAX_IMAGE_BYTES = 3_000_000

export interface PreparedImage {
  src: string
  naturalW: number
  naturalH: number
}

function loadImage(blob: Blob): Promise<{ img: HTMLImageElement; revoke: () => void }> {
  const url = URL.createObjectURL(blob)
  const revoke = () => URL.revokeObjectURL(url)
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve({ img, revoke })
    img.onerror = () => {
      revoke()
      reject(new Error(t('media.unreadable')))
    }
    img.src = url
  })
}

/** Whether the image has translucent pixels, which decides the format. */
function hasAlpha(ctx: CanvasRenderingContext2D, w: number, h: number): boolean {
  const { data } = ctx.getImageData(0, 0, w, h)
  // Sample every fourth pixel: transparent areas are large.
  for (let i = 3; i < data.length; i += 16) {
    if (data[i] < 250) return true
  }
  return false
}

/**
 * Scales an image down to a sensible size and turns it into a data URL.
 * Photos become JPEG; images with transparency stay PNG.
 */
export async function prepareImage(blob: Blob): Promise<PreparedImage> {
  const { img, revoke } = await loadImage(blob)
  try {
    const sw = img.naturalWidth || img.width || 800
    const sh = img.naturalHeight || img.height || 600
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(sw, sh))
    const w = Math.max(1, Math.round(sw * scale))
    const h = Math.max(1, Math.round(sh * scale))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) throw new Error('2D context unavailable')
    ctx.drawImage(img, 0, 0, w, h)

    let src = canvas.toDataURL(hasAlpha(ctx, w, h) ? 'image/png' : 'image/jpeg', 0.85)
    // Transparency is sacrificed only when keeping it would bloat the document.
    let quality = 0.8
    while (src.length > MAX_IMAGE_BYTES && quality >= 0.4) {
      src = canvas.toDataURL('image/jpeg', quality)
      quality -= 0.15
    }
    if (src.length > MAX_IMAGE_BYTES) {
      throw new Error(t('media.tooLarge'))
    }
    return { src, naturalW: w, naturalH: h }
  } finally {
    revoke()
  }
}

/** Size on the page: fit into a box without enlarging small images. */
export function fitOnPage(naturalW: number, naturalH: number): { w: number; h: number } {
  const boxW = BOARD_W * 0.62
  const boxH = BOARD_H * 0.45
  const scale = Math.min(1, boxW / naturalW, boxH / naturalH)
  return { w: naturalW * scale, h: naturalH * scale }
}

export function makeImageElement(
  prepared: PreparedImage,
  pageId: string,
  authorId: string,
  center: { x: number; y: number },
  name = 'Image',
): ImageElement {
  const { w, h } = fitOnPage(prepared.naturalW, prepared.naturalH)
  return {
    id: nanoid(10),
    type: 'image',
    pageId,
    authorId,
    createdAt: Date.now(),
    // Keep the image on the sheet: one placed past the edge looks lost.
    x: Math.max(0, Math.min(BOARD_W - w, center.x - w / 2)),
    y: Math.max(0, Math.min(BOARD_H - h, center.y - h / 2)),
    w,
    h,
    rotation: 0,
    opacity: 1,
    src: prepared.src,
    naturalW: prepared.naturalW,
    naturalH: prepared.naturalH,
    name: name.slice(0, 80),
  }
}

/* ------------------------------------------------------------------ */
/* Cache of decoded images used while drawing                          */
/* ------------------------------------------------------------------ */

const cache = new Map<string, HTMLImageElement>()

/** Waits for every image to decode, which export needs. */
export function preloadImages(srcs: string[]): Promise<void> {
  return Promise.all(
    srcs.map(
      (src) =>
        new Promise<void>((resolve) => {
          if (cachedImage(src, () => resolve())) resolve()
          else setTimeout(resolve, 5000)
        }),
    ),
  ).then(() => undefined)
}

/**
 * Returns an image ready to draw, or null while it is still loading.
 * `onReady` fires once the image becomes available.
 */
export function cachedImage(src: string, onReady: () => void): HTMLImageElement | null {
  const found = cache.get(src)
  if (found) return found.complete && found.naturalWidth > 0 ? found : null

  const img = new Image()
  cache.set(src, img)
  img.onload = onReady
  img.onerror = () => cache.delete(src)
  img.src = src
  return null
}
