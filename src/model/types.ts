/**
 * Logical size of a sheet: A4 in portrait at 96 dpi.
 *
 * Everything is stored in these units and does not depend on the screen. They
 * are convenient because export (jsPDF with the "px" unit) then produces an
 * exact A4 page, and one font point equals 4/3 of a unit, so text sizes read
 * the way they usually do.
 */
export const BOARD_W = 794
export const BOARD_H = 1123

/** Board units per millimetre. */
export const MM = BOARD_W / 210

export type Role = 'host' | 'editor' | 'viewer'

export type BrushKind = 'pen' | 'highlighter'

export type ShapeKind = 'rect' | 'ellipse' | 'line' | 'arrow' | 'triangle' | 'diamond' | 'star'

export type ToolId = 'select' | 'pan' | 'paper' | 'eraser' | 'text' | BrushKind | ShapeKind

/** Ruling printed on the paper. */
export type Ruling = 'blank' | 'grid' | 'lines' | 'dots'

/** Paper tint. Never pure white: it is tiring to look at for a whole lesson. */
export type PaperTint = 'cream' | 'blue' | 'plain'

export type Theme = 'light' | 'dark'

export interface PaperSettings {
  tint: PaperTint
  ruling: Ruling
  /** Ruling pitch in millimetres. */
  rulingMm: number
  /** Unruled border around the sheet, in millimetres. */
  marginMm: number
  /** Faint paper grain. */
  texture: boolean
}

export interface Page {
  id: string
  name: string
}

export { DEFAULT_PAPER } from '../../shared/doc.js'

interface ElementBase {
  id: string
  pageId: string
  authorId: string
  createdAt: number
}

/** A handwritten stroke. Points are stored flat as [x, y, pressure, …]. */
export interface StrokeElement extends ElementBase {
  type: 'stroke'
  brush: BrushKind
  points: number[]
  color: string
  /** Base thickness in board units. */
  size: number
  opacity: number
  /** True when pressure is simulated (mouse or touchpad); affects drawing. */
  simulated: boolean
}

export interface ShapeElement extends ElementBase {
  type: 'shape'
  shape: ShapeKind
  x: number
  y: number
  w: number
  h: number
  rotation: number
  color: string
  fill: string | null
  size: number
  opacity: number
}

export interface TextElement extends ElementBase {
  type: 'text'
  x: number
  y: number
  w: number
  h: number
  rotation: number
  text: string
  color: string
  fontSize: number
  opacity: number
}

export interface ImageElement extends ElementBase {
  type: 'image'
  x: number
  y: number
  w: number
  h: number
  rotation: number
  opacity: number
  /** The image as a data URL: the document is self-contained, with no files. */
  src: string
  /** Source size in pixels, needed to keep the aspect ratio. */
  naturalW: number
  naturalH: number
  /** Label for accessibility and tooltips. */
  name: string
}

export type BoardElement = StrokeElement | ShapeElement | TextElement | ImageElement

export interface BoardDoc {
  pages: Page[]
  elements: Record<string, BoardElement>
  /** Global z-order: element ids from bottom to top. */
  order: string[]
}

/* ------------------------------------------------------------------ */
/* Operations are the only way to change the document.                 */
/* ------------------------------------------------------------------ */

export type Op =
  | { t: 'add'; el: BoardElement; index?: number }
  | { t: 'update'; id: string; patch: Record<string, unknown> }
  | { t: 'remove'; ids: string[] }
  | { t: 'clearPage'; pageId: string }
  | { t: 'addPage'; page: Page; index: number }
  | { t: 'removePage'; pageId: string }
  | { t: 'patchPage'; pageId: string; patch: Partial<Omit<Page, 'id'>> }
  | { t: 'movePage'; pageId: string; index: number }
  | { t: 'z'; ids: string[]; to: 'front' | 'back' }
  | { t: 'setOrder'; ids: string[] }

/* ------------------------------------------------------------------ */
/* Network protocol                                                    */
/* ------------------------------------------------------------------ */

export interface Peer {
  id: string
  name: string
  role: Role
  color: string
  activePageId: string | null
}

export interface RoomSettings {
  /** Role given to a newly joined participant. */
  defaultRole: Exclude<Role, 'host'>
  /** Everyone follows the host's page. */
  followMode: boolean
  /** The host's page, used by followMode. */
  hostPageId: string | null
  /** The board is frozen: only the host may write. */
  locked: boolean
  roomName: string
  /** Board appearance: light or dark. */
  theme: Theme
  /** How the paper looks; the same for every sheet of the board. */
  paper: PaperSettings
}

/** An unfinished stroke broadcast in real time. */
export interface LiveStroke {
  id: string
  pageId: string
  brush: BrushKind
  color: string
  size: number
  opacity: number
  simulated: boolean
  points: number[]
}

export type ClientMessage =
  | { t: 'hello'; name: string; key?: string; clientId?: string }
  | { t: 'op'; op: Op }
  | { t: 'live'; id: string; pageId: string; style?: Omit<LiveStroke, 'id' | 'pageId' | 'points'>; points: number[]; end?: boolean }
  | { t: 'cursor'; pageId: string; x: number; y: number; drawing: boolean }
  | { t: 'activePage'; pageId: string }
  | { t: 'setRole'; clientId: string; role: Role }
  | { t: 'kick'; clientId: string }
  | { t: 'settings'; patch: Partial<RoomSettings> }
  | { t: 'rename'; name: string }
  | { t: 'resync' }
  | { t: 'ping' }

export type ServerMessage =
  | { t: 'welcome'; selfId: string; role: Role; doc: BoardDoc; peers: Peer[]; settings: RoomSettings; rev: number }
  | { t: 'op'; op: Op; from: string; rev: number }
  | { t: 'live'; from: string; id: string; pageId: string; style?: Omit<LiveStroke, 'id' | 'pageId' | 'points'>; points: number[]; end?: boolean }
  | { t: 'cursor'; from: string; pageId: string; x: number; y: number; drawing: boolean }
  | { t: 'peers'; peers: Peer[] }
  | { t: 'role'; role: Role }
  | { t: 'settings'; settings: RoomSettings }
  | { t: 'kicked'; reason: string }
  | { t: 'denied'; op?: Op; reason: string }
  | { t: 'sync'; doc: BoardDoc; rev: number }
  | { t: 'pong' }
