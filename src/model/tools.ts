import type { ShapeKind, ToolId } from './types'

/** "object" removes whatever it touches; "partial" cuts a piece out of handwriting. */
export type EraserMode = 'object' | 'partial'

export interface ToolSettings {
  tool: ToolId
  pen: { color: string; size: number }
  highlighter: { color: string; size: number; opacity: number }
  shape: { color: string; fill: string | null; size: number; opacity: number }
  text: { color: string; fontSize: number }
  eraser: { size: number; mode: EraserMode }
  /** Allow drawing with a finger on touch screens; otherwise a finger pans. */
  fingerDraw: boolean
  /** Use trackpad pressure where the browser exposes it. */
  trackpadPressure: boolean
}

export const INK_COLORS = [
  '#111827',
  '#ef4444',
  '#f97316',
  '#eab308',
  '#22c55e',
  '#0ea5e9',
  '#6366f1',
  '#ec4899',
  '#78716c',
  '#ffffff',
]

export const HIGHLIGHT_COLORS = [
  '#fde047',
  '#86efac',
  '#7dd3fc',
  '#f9a8d4',
  '#fdba74',
  '#c4b5fd',
]

// Sizes are in board units (A4 at 96 dpi, ~3.78 units per millimetre).
// Pen: from a 0.5 mm hairline to a 3.7 mm marker.
export const PEN_SIZES = [2, 3, 5, 8, 14]
// Highlighter: 3 to 10 mm, like a real one.
export const HIGHLIGHT_SIZES = [11, 17, 26, 38]
export const SHAPE_SIZES = [1, 2, 3, 5, 8]
export const ERASER_SIZES = [11, 26, 49, 95]
// Font size in board units: one point is 4/3 of a unit, so 16 is about 12 pt.
export const FONT_SIZES = [12, 16, 20, 28, 40]

/** Slider limits, also in board units. */
export const MAX_SIZE = {
  pen: 40,
  highlighter: 80,
  shape: 24,
  eraser: 120,
  font: 120,
} as const

export const DEFAULT_TOOLS: ToolSettings = {
  tool: 'pen',
  pen: { color: '#111827', size: 3 },
  highlighter: { color: '#fde047', size: 17, opacity: 0.38 },
  shape: { color: '#111827', fill: null, size: 2, opacity: 1 },
  text: { color: '#111827', fontSize: 16 },
  eraser: { size: 26, mode: 'object' },
  fingerDraw: false,
  trackpadPressure: true,
}

export const SHAPE_TOOLS: ShapeKind[] = [
  'rect',
  'ellipse',
  'line',
  'arrow',
  'triangle',
  'diamond',
  'star',
]

export const isShapeTool = (t: ToolId): t is ShapeKind =>
  (SHAPE_TOOLS as string[]).includes(t)

export const isBrushTool = (t: ToolId): t is 'pen' | 'highlighter' =>
  t === 'pen' || t === 'highlighter'

/** Keyboard shortcuts: key to tool. */
export const TOOL_HOTKEYS: Record<string, ToolId> = {
  v: 'select',
  p: 'pen',
  b: 'pen',
  h: 'highlighter',
  e: 'eraser',
  t: 'text',
  r: 'rect',
  o: 'ellipse',
  l: 'line',
  a: 'arrow',
  space: 'pan',
}
