import { BOARD_H, BOARD_W, MM, type PaperSettings, type PaperTint, type Theme } from '../model/types'

export interface PaperLook {
  /** Sheet fill. */
  paper: string
  /** Grid, lines and dots. */
  ruling: string
  /** The line that outlines the ruled area. */
  frame: string
  /** Shadow under the sheet. */
  shadow: string
  /** Everything around the sheets. */
  outside: string
}

/**
 * Paper never goes pure white: a whole lesson spent looking at #ffffff is
 * tiring, and on a projector it blows out. The dark theme keeps the same
 * three moods, only inverted.
 */
export const PAPER_LOOKS: Record<Theme, Record<PaperTint, PaperLook>> = {
  light: {
    cream: {
      paper: '#faf6ea',
      ruling: '#d9cdaa',
      frame: '#c9b98d',
      shadow: 'rgba(2, 6, 23, 0.55)',
      outside: '#0b1220',
    },
    blue: {
      paper: '#eef4fb',
      ruling: '#c3d6ea',
      frame: '#a8c4e0',
      shadow: 'rgba(2, 6, 23, 0.55)',
      outside: '#0b1220',
    },
    plain: {
      paper: '#f6f6f3',
      ruling: '#d5d5cf',
      frame: '#c2c2bb',
      shadow: 'rgba(2, 6, 23, 0.55)',
      outside: '#0b1220',
    },
  },
  dark: {
    cream: {
      paper: '#241f16',
      ruling: '#4a3f2c',
      frame: '#5d5037',
      shadow: 'rgba(0, 0, 0, 0.6)',
      outside: '#080d15',
    },
    blue: {
      paper: '#12232e',
      ruling: '#2f4a5c',
      frame: '#3b5b70',
      shadow: 'rgba(0, 0, 0, 0.6)',
      outside: '#080d15',
    },
    plain: {
      paper: '#1c1e22',
      ruling: '#3a3d43',
      frame: '#4a4e55',
      shadow: 'rgba(0, 0, 0, 0.6)',
      outside: '#080d15',
    },
  },
}

export const lookOf = (paper: PaperSettings, theme: Theme): PaperLook =>
  PAPER_LOOKS[theme][paper.tint] ?? PAPER_LOOKS[theme].plain

/** Area of the sheet the ruling is allowed to cover. */
export function rulingArea(paper: PaperSettings) {
  const margin = Math.max(0, Math.min(BOARD_W / 4, paper.marginMm * MM))
  return { x: margin, y: margin, w: BOARD_W - margin * 2, h: BOARD_H - margin * 2 }
}

const rulingWidth = 0.2 * MM

/**
 * Draws the ruling inside the margins. The margin is left blank on purpose:
 * a sheet whose grid runs into the very edge looks like a spreadsheet, not
 * like paper, and there is nowhere to put a heading or a note.
 */
export function drawRuling(
  ctx: CanvasRenderingContext2D,
  paper: PaperSettings,
  theme: Theme,
) {
  if (paper.ruling === 'blank') return
  const look = lookOf(paper, theme)
  const area = rulingArea(paper)
  const step = Math.max(2, paper.rulingMm) * MM

  ctx.save()
  ctx.beginPath()
  ctx.rect(area.x, area.y, area.w, area.h)
  ctx.clip()
  ctx.strokeStyle = look.ruling
  ctx.fillStyle = look.ruling
  ctx.lineWidth = rulingWidth

  if (paper.ruling === 'grid') {
    ctx.beginPath()
    for (let x = area.x + step; x < area.x + area.w; x += step) {
      ctx.moveTo(x, area.y)
      ctx.lineTo(x, area.y + area.h)
    }
    for (let y = area.y + step; y < area.y + area.h; y += step) {
      ctx.moveTo(area.x, y)
      ctx.lineTo(area.x + area.w, y)
    }
    ctx.stroke()
  } else if (paper.ruling === 'lines') {
    ctx.beginPath()
    for (let y = area.y + step; y < area.y + area.h; y += step) {
      ctx.moveTo(area.x, y)
      ctx.lineTo(area.x + area.w, y)
    }
    ctx.stroke()
  } else {
    const r = Math.max(0.35, step * 0.075)
    for (let x = area.x + step; x < area.x + area.w; x += step) {
      for (let y = area.y + step; y < area.y + area.h; y += step) {
        ctx.beginPath()
        ctx.arc(x, y, r, 0, Math.PI * 2)
        ctx.fill()
      }
    }
  }
  ctx.restore()

  // The ruled area is outlined, so the margin reads as a deliberate border.
  if (paper.marginMm > 0) {
    ctx.save()
    ctx.strokeStyle = look.frame
    ctx.lineWidth = rulingWidth * 1.5
    ctx.strokeRect(area.x, area.y, area.w, area.h)
    ctx.restore()
  }
}

/* ------------------------------------------------------------------ */
/* Grain                                                               */
/* ------------------------------------------------------------------ */

/**
 * A tile of paper grain. The generator is seeded, so the texture is identical
 * between redraws and between the screen and an export.
 */
export function makeGrainTile(size = 128, strength = 20): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  const ctx = canvas.getContext('2d')!
  const image = ctx.createImageData(size, size)
  let seed = 0x2f6e2b1
  const random = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296)
  for (let i = 0; i < size * size; i++) {
    const value = random()
    const tone = value < 0.5 ? 0 : 255
    image.data[i * 4] = tone
    image.data[i * 4 + 1] = tone
    image.data[i * 4 + 2] = tone
    image.data[i * 4 + 3] = Math.round(Math.abs(value - 0.5) * 2 * strength)
  }
  ctx.putImageData(image, 0, 0)
  return canvas
}

let grainTile: HTMLCanvasElement | null = null

/**
 * Lays the grain over the sheet.
 *
 * `pixelScale` maps one tile pixel onto one device pixel, so the grain never
 * shimmers or moirés as the board is zoomed.
 */
export function drawGrain(
  ctx: CanvasRenderingContext2D,
  pixelScale: number,
  width = BOARD_W,
  height = BOARD_H,
) {
  grainTile ??= makeGrainTile()
  const pattern = ctx.createPattern(grainTile, 'repeat')
  if (!pattern) return
  pattern.setTransform(new DOMMatrix().scale(pixelScale))
  ctx.save()
  ctx.fillStyle = pattern
  ctx.fillRect(0, 0, width, height)
  ctx.restore()
}

/** Fills the sheet: tint, optional grain, then the ruling. */
export function drawPaper(
  ctx: CanvasRenderingContext2D,
  paper: PaperSettings,
  theme: Theme,
  pixelScale = 1,
) {
  const look = lookOf(paper, theme)
  ctx.save()
  ctx.fillStyle = look.paper
  ctx.fillRect(0, 0, BOARD_W, BOARD_H)
  ctx.restore()
  if (paper.texture) drawGrain(ctx, pixelScale)
  drawRuling(ctx, paper, theme)
}
