import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icon'
import { getLang, LANGUAGES, setLang, t, useLang, type MessageKey } from '../i18n'
import type { Session } from '../net/session'

export interface ExportRequest {
  kind: 'pdf-all' | 'pdf-page' | 'pdf-raster' | 'png'
}

interface Props {
  session: Session
  canUndo: boolean
  canRedo: boolean
  onUndo: () => void
  onRedo: () => void
  onExport: (req: ExportRequest) => void
  onShare: () => void
  onToggleParticipants: () => void
  participantsOpen: boolean
  busy: string | null
}

const EXPORT_ITEMS: { kind: ExportRequest['kind']; key: MessageKey; tag?: MessageKey }[] = [
  { kind: 'pdf-all', key: 'export.pdfAll', tag: 'export.vector' },
  { kind: 'pdf-page', key: 'export.pdfPage' },
  { kind: 'pdf-raster', key: 'export.pdfRaster', tag: 'export.raster' },
  { kind: 'png', key: 'export.png' },
]

export function TopBar({
  session,
  canUndo,
  canRedo,
  onUndo,
  onRedo,
  onExport,
  onShare,
  onToggleParticipants,
  participantsOpen,
  busy,
}: Props) {
  const lang = useLang()
  const [menu, setMenu] = useState(false)
  const [editName, setEditName] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (!menuRef.current?.contains(e.target as Node)) setMenu(false)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const { settings } = session
  const boardName = settings.roomName || t('app.untitled')
  const nextLang = LANGUAGES[(LANGUAGES.findIndex((l) => l.id === lang) + 1) % LANGUAGES.length]

  return (
    <header className="topbar">
      <div className="brand">
        <span className="brand-dot" />
        {editName && session.isHost ? (
          <input
            className="room-name-input"
            autoFocus
            defaultValue={settings.roomName}
            onBlur={(e) => {
              session.patchSettings({ roomName: e.target.value.slice(0, 60) })
              setEditName(false)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
              if (e.key === 'Escape') setEditName(false)
            }}
          />
        ) : (
          <button
            type="button"
            className="room-name"
            onClick={() => session.isHost && setEditName(true)}
            title={session.isHost ? t('top.rename') : undefined}
          >
            {boardName}
          </button>
        )}
        <span className={`status status-${session.status}`}>
          {t(`status.${session.status}` as MessageKey)}
          {session.pendingCount > 0 && ` · ${t('status.pending', { n: session.pendingCount })}`}
        </span>
      </div>

      <div className="topbar-center">
        <button type="button" onClick={onUndo} disabled={!canUndo} title={t('top.undo')}>
          <Icon name="undo" size={18} />
        </button>
        <button type="button" onClick={onRedo} disabled={!canRedo} title={t('top.redo')}>
          <Icon name="redo" size={18} />
        </button>
      </div>

      <div className="topbar-right">
        <button
          type="button"
          className="lang-btn"
          onClick={() => setLang(nextLang.id)}
          title={`${t('top.language')}: ${nextLang.label}`}
        >
          {LANGUAGES.find((l) => l.id === getLang())?.short}
        </button>

        {session.isHost && (
          <>
            <button
              type="button"
              className={settings.locked ? 'active' : ''}
              onClick={() => session.patchSettings({ locked: !settings.locked })}
              title={settings.locked ? t('top.unlock') : t('top.lock')}
            >
              <Icon name={settings.locked ? 'lock' : 'unlock'} size={18} />
            </button>
            <button
              type="button"
              className={settings.followMode ? 'active' : ''}
              onClick={() => session.patchSettings({ followMode: !settings.followMode })}
              title={t('top.follow')}
            >
              <Icon name="follow" size={18} />
            </button>
            <button
              type="button"
              onClick={() =>
                session.patchSettings({ theme: settings.theme === 'light' ? 'dark' : 'light' })
              }
              title={t('top.theme')}
            >
              <Icon name="eye" size={18} />
            </button>
            <button type="button" onClick={onShare} title={t('top.share')}>
              <Icon name="share" size={18} />
            </button>
          </>
        )}

        <div className="menu-wrap" ref={menuRef}>
          <button
            type="button"
            className={menu ? 'active' : ''}
            onClick={() => setMenu((open) => !open)}
            title={t('export.title')}
            disabled={Boolean(busy)}
          >
            <Icon name="download" size={18} />
            <span className="btn-text">{busy ?? t('export.title')}</span>
          </button>
          {menu && (
            <div className="dropdown">
              {EXPORT_ITEMS.map((item, i) => (
                <div key={item.kind}>
                  {i === EXPORT_ITEMS.length - 1 && <div className="dropdown-sep" />}
                  <button
                    type="button"
                    onClick={() => {
                      setMenu(false)
                      onExport({ kind: item.kind })
                    }}
                  >
                    {t(item.key)}
                    {item.tag && <span>{t(item.tag)}</span>}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <button
          type="button"
          className={participantsOpen ? 'active' : ''}
          onClick={onToggleParticipants}
          title={t('top.participants')}
        >
          <Icon name="users" size={18} />
          <span className="badge">{Math.max(1, session.peers.length)}</span>
        </button>
      </div>
    </header>
  )
}
