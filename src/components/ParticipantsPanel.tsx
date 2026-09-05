import { Icon } from './Icon'
import { t, useLang, type MessageKey } from '../i18n'
import type { Role } from '../model/types'
import type { Session } from '../net/session'

const ROLE_ORDER: Role[] = ['viewer', 'editor', 'host']

interface Props {
  session: Session
  onClose: () => void
}

export function ParticipantsPanel({ session, onClose }: Props) {
  useLang()
  const peers = session.peers.length
    ? session.peers
    : [
        {
          id: session.selfId,
          name: t('peers.self'),
          role: session.role,
          color: '#0ea5e9',
          activePageId: null,
        },
      ]
  const pages = session.store.doc.pages

  return (
    <aside className="participants">
      <div className="panel-head">
        <h2>{t('peers.title', { n: peers.length })}</h2>
        <button type="button" onClick={onClose} aria-label={t('common.close')}>
          <Icon name="close" size={18} />
        </button>
      </div>

      {session.isHost && (
        <label className="check-row">
          {t('peers.newcomers')}
          <select
            value={session.settings.defaultRole}
            onChange={(e) =>
              session.patchSettings({ defaultRole: e.target.value as 'editor' | 'viewer' })
            }
          >
            <option value="editor">{t('peers.canWrite')}</option>
            <option value="viewer">{t('peers.viewOnly')}</option>
          </select>
        </label>
      )}

      <ul className="peer-list">
        {peers.map((peer) => {
          const pageIndex = pages.findIndex((p) => p.id === peer.activePageId)
          return (
            <li key={peer.id} className={peer.id === session.selfId ? 'self' : ''}>
              <span className="peer-dot" style={{ background: peer.color }} />
              <div className="peer-main">
                <div className="peer-name">
                  {peer.name}
                  {peer.id === session.selfId && <span className="you">{t('peers.you')}</span>}
                  {peer.role === 'host' && (
                    <span className="host-mark" title={t('role.host')}>
                      <Icon name="crown" size={13} />
                    </span>
                  )}
                </div>
                <div className="peer-sub">
                  {t(`role.${peer.role}` as MessageKey)}
                  {pageIndex >= 0 && t('peers.onPage', { n: pageIndex + 1 })}
                </div>
              </div>
              {session.isHost && peer.id !== session.selfId && (
                <div className="peer-actions">
                  <select
                    value={peer.role}
                    onChange={(e) => session.setRole(peer.id, e.target.value as Role)}
                    title={t('peers.rights')}
                  >
                    {ROLE_ORDER.map((role) => (
                      <option key={role} value={role}>
                        {t(`role.short${role[0].toUpperCase()}${role.slice(1)}` as MessageKey)}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="danger"
                    title={t('peers.kick')}
                    onClick={() => {
                      if (confirm(t('peers.kickConfirm', { name: peer.name }))) {
                        session.kick(peer.id)
                      }
                    }}
                  >
                    <Icon name="close" size={15} />
                  </button>
                </div>
              )}
            </li>
          )
        })}
      </ul>

      {session.status === 'offline' && <p className="offline-note">{t('peers.offlineNote')}</p>}
    </aside>
  )
}
