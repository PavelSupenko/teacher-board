import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react'
import { Icon } from './Icon'
import { isShapeTool, SHAPE_TOOLS, type ToolSettings } from '../model/tools'
import { t, useLang, type MessageKey } from '../i18n'
import type { ShapeKind, ToolId } from '../model/types'

const shapeLabel = (shape: ShapeKind) => t(`shape.${shape}` as MessageKey)

const MAIN_TOOLS: { id: ToolId; icon: string; key: MessageKey; hotkey: string }[] = [
  { id: 'select', icon: 'cursor', key: 'tool.select', hotkey: 'V' },
  { id: 'pen', icon: 'pen', key: 'tool.pen', hotkey: 'P' },
  { id: 'highlighter', icon: 'highlighter', key: 'tool.highlighter', hotkey: 'H' },
  { id: 'eraser', icon: 'eraser', key: 'tool.eraser', hotkey: 'E' },
  { id: 'text', icon: 'text', key: 'tool.text', hotkey: 'T' },
]

interface Props {
  tools: ToolSettings
  setTools: Dispatch<SetStateAction<ToolSettings>>
  disabled: boolean
  onInsertImage: () => void
  /** Only the host may restyle the paper, so only they get the button. */
  canStylePaper: boolean
}

export function Toolbar({ tools, setTools, disabled, onInsertImage, canStylePaper }: Props) {
  useLang()
  const [shapeMenu, setShapeMenu] = useState(false)
  const [lastShape, setLastShape] = useState<ShapeKind>('rect')
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (isShapeTool(tools.tool)) setLastShape(tools.tool)
  }, [tools.tool])

  useEffect(() => {
    if (!shapeMenu) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setShapeMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [shapeMenu])

  const pick = (id: ToolId) => setTools((s) => ({ ...s, tool: id }))

  return (
    <div className="toolbar">
      {MAIN_TOOLS.map((tool) => (
        <button
          key={tool.id}
          type="button"
          className={`tool-btn${tools.tool === tool.id ? ' active' : ''}`}
          onClick={() => pick(tool.id)}
          disabled={disabled && tool.id !== 'select'}
          title={t('tool.withHotkey', { label: t(tool.key), key: tool.hotkey })}
        >
          <Icon name={tool.icon} />
        </button>
      ))}

      <div className="tool-group" ref={menuRef}>
        <button
          type="button"
          className={`tool-btn${isShapeTool(tools.tool) ? ' active' : ''}`}
          onClick={() => pick(lastShape)}
          onContextMenu={(e) => {
            e.preventDefault()
            setShapeMenu((open) => !open)
          }}
          disabled={disabled}
          title={t('tool.shapeMenu', { shape: shapeLabel(lastShape) })}
        >
          <Icon name={lastShape} />
        </button>
        <button
          type="button"
          className="tool-more"
          onClick={() => setShapeMenu((open) => !open)}
          disabled={disabled}
          aria-label={t('tool.pickShape')}
        />
        {shapeMenu && (
          <div className="shape-menu">
            {SHAPE_TOOLS.map((shape) => (
              <button
                key={shape}
                type="button"
                className={`tool-btn${tools.tool === shape ? ' active' : ''}`}
                title={shapeLabel(shape)}
                onClick={() => {
                  setLastShape(shape)
                  pick(shape)
                  setShapeMenu(false)
                }}
              >
                <Icon name={shape} />
              </button>
            ))}
          </div>
        )}
      </div>

      <button
        type="button"
        className="tool-btn"
        onClick={onInsertImage}
        disabled={disabled}
        title={t('tool.image')}
      >
        <Icon name="image" />
      </button>

      {canStylePaper && (
        <button
          type="button"
          className={`tool-btn${tools.tool === 'paper' ? ' active' : ''}`}
          onClick={() => pick('paper')}
          title={t('tool.paper')}
        >
          <Icon name="page" />
        </button>
      )}

      <button
        type="button"
        className={`tool-btn${tools.tool === 'pan' ? ' active' : ''}`}
        onClick={() => pick('pan')}
        title={t('tool.pan')}
      >
        <Icon name="hand" />
      </button>
    </div>
  )
}
