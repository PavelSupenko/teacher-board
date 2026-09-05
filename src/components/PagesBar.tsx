import { nanoid } from 'nanoid'
import { Icon } from './Icon'
import { t, useLang } from '../i18n'
import type { Session } from '../net/session'

interface Props {
  session: Session
  pageId: string
  onPageChange: (id: string) => void
  zoom: number
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
}

export function PagesBar({
  session,
  pageId,
  onPageChange,
  zoom,
  onZoomIn,
  onZoomOut,
  onFit,
}: Props) {
  useLang()
  const { pages } = session.store.doc
  const page = pages.find((p) => p.id === pageId)
  const isHost = session.isHost
  const followed = session.settings.followMode && !isHost

  const addPage = () => {
    const id = nanoid(8)
    const index = pages.findIndex((p) => p.id === pageId) + 1
    session.store.commit({
      t: 'addPage',
      page: { id, name: `Page ${pages.length + 1}` },
      index,
    })
    onPageChange(id)
  }

  return (
    <div className="pagesbar">
      <div className="pages">
        {pages.map((p, i) => (
          <button
            key={p.id}
            type="button"
            className={`page-chip${p.id === pageId ? ' active' : ''}`}
            onClick={() => !followed && onPageChange(p.id)}
            disabled={followed}
            title={t('page.goTo', { n: i + 1 })}
          >
            {i + 1}
          </button>
        ))}
        {isHost && (
          <button type="button" className="page-chip add" onClick={addPage} title={t('page.new')}>
            <Icon name="plus" size={16} />
          </button>
        )}
      </div>

      {isHost && page && (
        <div className="page-tools">
          <button
            type="button"
            onClick={() => {
              if (confirm(t('page.clearConfirm'))) {
                session.store.commit({ t: 'clearPage', pageId: page.id })
              }
            }}
            title={t('page.clear')}
          >
            <Icon name="trash" size={16} />
          </button>
          <button
            type="button"
            disabled={pages.length <= 1}
            onClick={() => {
              if (!confirm(t('page.deleteConfirm'))) return
              const idx = pages.findIndex((p) => p.id === page.id)
              session.store.commit({ t: 'removePage', pageId: page.id })
              const next = session.store.doc.pages[Math.max(0, idx - 1)]
              if (next) onPageChange(next.id)
            }}
            title={t('page.delete')}
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      )}

      <div className="zoom-tools">
        <button type="button" onClick={onZoomOut} title={t('zoom.out')}>
          <Icon name="minus" size={16} />
        </button>
        <button type="button" className="zoom-value" onClick={onFit} title={t('zoom.fit')}>
          {Math.round(zoom * 100)}%
        </button>
        <button type="button" onClick={onZoomIn} title={t('zoom.in')}>
          <Icon name="plus" size={16} />
        </button>
        <button type="button" onClick={onFit} title={t('zoom.fit')}>
          <Icon name="fit" size={16} />
        </button>
      </div>
    </div>
  )
}
