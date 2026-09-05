import type { Dispatch, SetStateAction } from 'react'
import { nanoid } from 'nanoid'
import { Icon } from './Icon'
import {
  ERASER_SIZES,
  FONT_SIZES,
  HIGHLIGHT_COLORS,
  HIGHLIGHT_SIZES,
  INK_COLORS,
  isBrushTool,
  isShapeTool,
  MAX_SIZE,
  PEN_SIZES,
  SHAPE_SIZES,
  type ToolSettings,
} from '../model/tools'
import { FORCE_TOUCH_SUPPORTED } from '../input/forceTouch'
import { PAPER_LOOKS } from '../render/paper'
import { t, useLang, type MessageKey } from '../i18n'
import type { BoardElement, PaperTint, Ruling } from '../model/types'
import type { Session } from '../net/session'

const TINTS: PaperTint[] = ['cream', 'blue', 'plain']
const RULINGS: Ruling[] = ['blank', 'grid', 'lines', 'dots']

const FILL_COLORS = [...HIGHLIGHT_COLORS, ...INK_COLORS.slice(0, 8)]

interface Props {
  session: Session
  tools: ToolSettings
  setTools: Dispatch<SetStateAction<ToolSettings>>
  selection: string[]
  onSelectionChange: Dispatch<SetStateAction<string[]>>
  pageId: string
}

function Swatches({
  colors,
  value,
  onPick,
}: {
  colors: string[]
  value: string | null
  onPick: (color: string) => void
}) {
  return (
    <div className="swatches">
      {colors.map((color) => (
        <button
          key={color}
          type="button"
          className={`swatch${value === color ? ' active' : ''}`}
          style={{ background: color }}
          onClick={() => onPick(color)}
          aria-label={color}
        />
      ))}
      <label className="swatch custom" title={t('style.customColor')}>
        <input
          type="color"
          value={value && value.startsWith('#') ? value : '#000000'}
          onChange={(e) => onPick(e.target.value)}
        />
      </label>
    </div>
  )
}

function SizeRow({
  sizes,
  value,
  onPick,
  max,
}: {
  sizes: number[]
  value: number
  onPick: (size: number) => void
  max: number
}) {
  return (
    <>
      <div className="size-row">
        {sizes.map((size) => (
          <button
            key={size}
            type="button"
            className={`size-btn${value === size ? ' active' : ''}`}
            onClick={() => onPick(size)}
            aria-label={`${size}`}
          >
            <span
              style={{
                width: Math.min(22, 3 + size * 1.1),
                height: Math.min(22, 3 + size * 1.1),
              }}
            />
          </button>
        ))}
      </div>
      <input
        className="slider"
        type="range"
        min={1}
        max={max}
        step={1}
        value={Math.round(value)}
        onChange={(e) => onPick(Number(e.target.value))}
      />
    </>
  )
}

export function StylePanel({
  session,
  tools,
  setTools,
  selection,
  onSelectionChange,
  pageId,
}: Props) {
  useLang()
  const selected = selection
    .map((id) => session.store.element(id))
    .filter((el): el is BoardElement => !!el && session.canEditElement(el.authorId))

  const patchSelection = (make: (el: BoardElement) => Record<string, unknown> | null) => {
    session.store.transaction(() => {
      for (const el of selected) {
        const patch = make(el)
        if (patch) session.store.commit({ t: 'update', id: el.id, patch })
      }
    })
  }

  /* ---------------- editing the current selection ---------------- */

  if (selected.length) {
    const first = selected[0]
    const hasShapes = selected.some((el) => el.type === 'shape')
    const hasColor = selected.some((el) => el.type !== 'image')
    const sizeValue =
      first.type === 'text' ? first.fontSize : first.type === 'image' ? 0 : first.size

    return (
      <div className="style-panel">
        <div className="panel-title">
          {t('style.selected', { n: selected.length })}
          {selected.length !== selection.length && (
            <span className="hint">{t('style.selectedForeign')}</span>
          )}
        </div>

        {hasColor && (
          <>
            <div className="panel-label">{t('style.color')}</div>
            <Swatches
              colors={INK_COLORS}
              value={'color' in first ? first.color : null}
              onPick={(color) =>
                patchSelection((el) => (el.type === 'image' ? null : { color }))
              }
            />
          </>
        )}

        {hasShapes && (
          <>
            <div className="panel-label">{t('style.fill')}</div>
            <div className="swatches">
              <button
                type="button"
                className="swatch none"
                onClick={() => patchSelection((el) => (el.type === 'shape' ? { fill: null } : null))}
                title={t('style.noFill')}
              >
                <Icon name="close" size={12} />
              </button>
              {FILL_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className="swatch"
                  style={{ background: color }}
                  onClick={() => patchSelection((el) => (el.type === 'shape' ? { fill: color } : null))}
                  aria-label={color}
                />
              ))}
            </div>
          </>
        )}

        {first.type !== 'image' && (
          <>
            <div className="panel-label">
              {first.type === 'text' ? t('style.fontSize') : t('style.thickness')}
            </div>
            <input
              className="slider"
              type="range"
              min={first.type === 'text' ? 8 : 0}
              max={first.type === 'text' ? MAX_SIZE.font : MAX_SIZE.highlighter}
              value={Math.round(sizeValue)}
              onChange={(e) => {
                const size = Number(e.target.value)
                patchSelection((el) =>
                  el.type === 'text'
                    ? { fontSize: size }
                    : el.type === 'image'
                      ? null
                      : { size },
                )
              }}
            />
          </>
        )}

        <div className="panel-label">{t('style.opacity')}</div>
        <input
          className="slider"
          type="range"
          min={5}
          max={100}
          value={Math.round(('opacity' in first ? first.opacity : 1) * 100)}
          onChange={(e) => patchSelection(() => ({ opacity: Number(e.target.value) / 100 }))}
        />

        <div className="panel-actions">
          <button
            type="button"
            onClick={() =>
              session.store.commit({ t: 'z', ids: selected.map((el) => el.id), to: 'front' })
            }
            title={t('style.bringFront')}
          >
            <Icon name="front" size={18} />
          </button>
          <button
            type="button"
            onClick={() =>
              session.store.commit({ t: 'z', ids: selected.map((el) => el.id), to: 'back' })
            }
            title={t('style.sendBack')}
          >
            <Icon name="back" size={18} />
          </button>
          <button
            type="button"
            title={t('style.duplicate')}
            onClick={() => {
              const ids: string[] = []
              session.store.transaction(() => {
                for (const el of selected) {
                  const copy = structuredClone(el)
                  copy.id = nanoid(10)
                  copy.authorId = session.selfId
                  copy.pageId = pageId
                  if (copy.type === 'stroke') {
                    for (let i = 0; i < copy.points.length; i += 3) {
                      copy.points[i] += 24
                      copy.points[i + 1] += 24
                    }
                  } else {
                    copy.x += 24
                    copy.y += 24
                  }
                  ids.push(copy.id)
                  session.store.commit({ t: 'add', el: copy })
                }
              })
              onSelectionChange(ids)
            }}
          >
            <Icon name="copy" size={18} />
          </button>
          <button
            type="button"
            className="danger"
            title={t('style.delete')}
            onClick={() => {
              session.store.commit({ t: 'remove', ids: selected.map((el) => el.id) })
              onSelectionChange([])
            }}
          >
            <Icon name="trash" size={18} />
          </button>
        </div>
      </div>
    )
  }

  /* ---------------- settings of the current tool ---------------- */

  const { tool } = tools

  /* ---------------- how the paper looks ---------------- */

  if (tool === 'paper') {
    if (!session.isHost) return <div className="style-panel hint">{t('paper.hostOnly')}</div>
    const paper = session.settings.paper
    const looks = PAPER_LOOKS[session.settings.theme]
    const patchPaper = (patch: Partial<typeof paper>) =>
      session.patchSettings({ paper: { ...paper, ...patch } })

    return (
      <div className="style-panel">
        <div className="panel-title">{t('paper.title')}</div>

        <div className="panel-label">{t('paper.tint')}</div>
        <div className="tint-row">
          {TINTS.map((tint) => (
            <button
              key={tint}
              type="button"
              className={`tint${paper.tint === tint ? ' active' : ''}`}
              style={{ background: looks[tint].paper, borderColor: looks[tint].frame }}
              onClick={() => patchPaper({ tint })}
              title={t(`paper.tint.${tint}` as MessageKey)}
            />
          ))}
        </div>

        <div className="panel-label">{t('paper.ruling')}</div>
        <div className="mode-row wrap">
          {RULINGS.map((ruling) => (
            <button
              key={ruling}
              type="button"
              className={paper.ruling === ruling ? 'active' : ''}
              onClick={() => patchPaper({ ruling })}
            >
              {t(`paper.ruling.${ruling}` as MessageKey)}
            </button>
          ))}
        </div>

        {paper.ruling !== 'blank' && (
          <>
            <div className="panel-label">{t('paper.size', { n: paper.rulingMm })}</div>
            <input
              className="slider"
              type="range"
              min={2}
              max={20}
              step={1}
              value={paper.rulingMm}
              onChange={(e) => patchPaper({ rulingMm: Number(e.target.value) })}
            />
          </>
        )}

        <div className="panel-label">{t('paper.margin', { n: paper.marginMm })}</div>
        <input
          className="slider"
          type="range"
          min={0}
          max={25}
          step={1}
          value={paper.marginMm}
          onChange={(e) => patchPaper({ marginMm: Number(e.target.value) })}
        />

        <label className="check-row">
          <input
            type="checkbox"
            checked={paper.texture}
            onChange={(e) => patchPaper({ texture: e.target.checked })}
          />
          {t('paper.texture')}
        </label>

        <div className="hint">{t('paper.hint')}</div>
      </div>
    )
  }

  if (tool === 'select' || tool === 'pan') return null

  return (
    <div className="style-panel">
      {tool === 'pen' && (
        <>
          <div className="panel-label">{t('style.penColor')}</div>
          <Swatches
            colors={INK_COLORS}
            value={tools.pen.color}
            onPick={(color) => setTools((s) => ({ ...s, pen: { ...s.pen, color } }))}
          />
          <div className="panel-label">{t('style.thickness')}</div>
          <SizeRow
            sizes={PEN_SIZES}
            value={tools.pen.size}
            max={MAX_SIZE.pen}
            onPick={(size) => setTools((s) => ({ ...s, pen: { ...s.pen, size } }))}
          />
        </>
      )}

      {tool === 'highlighter' && (
        <>
          <div className="panel-label">{t('style.highlighterColor')}</div>
          <Swatches
            colors={HIGHLIGHT_COLORS}
            value={tools.highlighter.color}
            onPick={(color) =>
              setTools((s) => ({ ...s, highlighter: { ...s.highlighter, color } }))
            }
          />
          <div className="panel-label">{t('style.width')}</div>
          <SizeRow
            sizes={HIGHLIGHT_SIZES}
            value={tools.highlighter.size}
            max={MAX_SIZE.highlighter}
            onPick={(size) => setTools((s) => ({ ...s, highlighter: { ...s.highlighter, size } }))}
          />
          <div className="panel-label">
            {t('style.opacityValue', { n: Math.round(tools.highlighter.opacity * 100) })}
          </div>
          <input
            className="slider"
            type="range"
            min={10}
            max={90}
            value={Math.round(tools.highlighter.opacity * 100)}
            onChange={(e) =>
              setTools((s) => ({
                ...s,
                highlighter: { ...s.highlighter, opacity: Number(e.target.value) / 100 },
              }))
            }
          />
        </>
      )}

      {isShapeTool(tool) && (
        <>
          <div className="panel-label">{t('style.outline')}</div>
          <Swatches
            colors={INK_COLORS}
            value={tools.shape.color}
            onPick={(color) => setTools((s) => ({ ...s, shape: { ...s.shape, color } }))}
          />
          <div className="panel-label">{t('style.fill')}</div>
          <div className="swatches">
            <button
              type="button"
              className={`swatch none${tools.shape.fill === null ? ' active' : ''}`}
              onClick={() => setTools((s) => ({ ...s, shape: { ...s.shape, fill: null } }))}
              title={t('style.noFill')}
            >
              <Icon name="close" size={12} />
            </button>
            {FILL_COLORS.map((color) => (
              <button
                key={color}
                type="button"
                className={`swatch${tools.shape.fill === color ? ' active' : ''}`}
                style={{ background: color }}
                onClick={() => setTools((s) => ({ ...s, shape: { ...s.shape, fill: color } }))}
                aria-label={color}
              />
            ))}
          </div>
          <div className="panel-label">{t('style.lineThickness')}</div>
          <SizeRow
            sizes={SHAPE_SIZES}
            value={tools.shape.size}
            max={MAX_SIZE.shape}
            onPick={(size) => setTools((s) => ({ ...s, shape: { ...s.shape, size } }))}
          />
          <div className="panel-label">
            {t('style.opacityValue', { n: Math.round(tools.shape.opacity * 100) })}
          </div>
          <input
            className="slider"
            type="range"
            min={10}
            max={100}
            value={Math.round(tools.shape.opacity * 100)}
            onChange={(e) =>
              setTools((s) => ({
                ...s,
                shape: { ...s.shape, opacity: Number(e.target.value) / 100 },
              }))
            }
          />
          <div className="hint">{t('style.shapeHint')}</div>
        </>
      )}

      {tool === 'text' && (
        <>
          <div className="panel-label">{t('style.color')}</div>
          <Swatches
            colors={INK_COLORS}
            value={tools.text.color}
            onPick={(color) => setTools((s) => ({ ...s, text: { ...s.text, color } }))}
          />
          <div className="panel-label">{t('style.fontSize')}</div>
          <SizeRow
            sizes={FONT_SIZES}
            value={tools.text.fontSize}
            max={MAX_SIZE.font}
            onPick={(fontSize) => setTools((s) => ({ ...s, text: { ...s.text, fontSize } }))}
          />
        </>
      )}

      {tool === 'eraser' && (
        <>
          <div className="panel-label">{t('eraser.what')}</div>
          <div className="mode-row">
            <button
              type="button"
              className={tools.eraser.mode === 'object' ? 'active' : ''}
              onClick={() => setTools((s) => ({ ...s, eraser: { ...s.eraser, mode: 'object' } }))}
            >
              {t('eraser.object')}
            </button>
            <button
              type="button"
              className={tools.eraser.mode === 'partial' ? 'active' : ''}
              onClick={() => setTools((s) => ({ ...s, eraser: { ...s.eraser, mode: 'partial' } }))}
            >
              {t('eraser.partial')}
            </button>
          </div>
          <div className="panel-label">{t('eraser.size')}</div>
          <SizeRow
            sizes={ERASER_SIZES}
            value={tools.eraser.size}
            max={MAX_SIZE.eraser}
            onPick={(size) => setTools((s) => ({ ...s, eraser: { ...s.eraser, size } }))}
          />
          <div className="hint">
            {tools.eraser.mode === 'object' ? t('eraser.objectHint') : t('eraser.partialHint')}
          </div>
        </>
      )}

      {isBrushTool(tool) && (
        <label className="check-row">
          <input
            type="checkbox"
            checked={tools.fingerDraw}
            onChange={(e) => setTools((s) => ({ ...s, fingerDraw: e.target.checked }))}
          />
          {t('style.fingerDraw')}
        </label>
      )}

      {isBrushTool(tool) && FORCE_TOUCH_SUPPORTED && (
        <label className="check-row" title={t('style.trackpadPressureHint')}>
          <input
            type="checkbox"
            checked={tools.trackpadPressure}
            onChange={(e) => setTools((s) => ({ ...s, trackpadPressure: e.target.checked }))}
          />
          {t('style.trackpadPressure')}
        </label>
      )}
    </div>
  )
}
