import { useEffect, useState } from 'react'
import { Icon } from './Icon'
import { LANGUAGES, setLang, t, useLang } from '../i18n'

/* ------------------------------------------------------------------ */
/* Entry: participant name                                             */
/* ------------------------------------------------------------------ */

export function JoinDialog({
  defaultName,
  isHost,
  onSubmit,
}: {
  defaultName: string
  isHost: boolean
  onSubmit: (name: string) => void
}) {
  const lang = useLang()
  const [name, setName] = useState(defaultName)
  const fallback = isHost ? t('join.teacher') : t('join.participant')

  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        onSubmit={(e) => {
          e.preventDefault()
          onSubmit(name.trim() || fallback)
        }}
      >
        <h1>{t('app.title')}</h1>
        <p className="modal-sub">{isHost ? t('join.subHost') : t('join.subGuest')}</p>
        <label className="field">
          {t('join.name')}
          <input
            autoFocus
            value={name}
            maxLength={40}
            placeholder={isHost ? t('join.teacher') : t('join.namePlaceholder')}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        <div className="lang-row">
          {LANGUAGES.map((option) => (
            <button
              key={option.id}
              type="button"
              className={option.id === lang ? 'active' : ''}
              onClick={() => setLang(option.id)}
            >
              {option.label}
            </button>
          ))}
        </div>
        <button type="submit" className="primary">
          {t('join.submit')}
        </button>
      </form>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Invitation links                                                    */
/* ------------------------------------------------------------------ */

interface ServerInfo {
  addresses: string[]
  port: number
}

export function ShareDialog({ hostKey, onClose }: { hostKey: string | null; onClose: () => void }) {
  useLang()
  const [info, setInfo] = useState<ServerInfo | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/info')
      .then((r) => r.json())
      .then((data) => setInfo({ addresses: data.addresses ?? [], port: data.port }))
      .catch(() => setInfo({ addresses: [], port: Number(location.port) || 80 }))
  }, [])

  const guestLinks = info?.addresses.length
    ? info.addresses.map((address) => `http://${address}:${info.port}/`)
    : [`${location.origin}/`]
  const hostLinks = hostKey ? guestLinks.map((link) => `${link}?key=${hostKey}`) : []

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
    } catch {
      // Clipboard access can be denied; fall back to the old selection trick.
      const area = document.createElement('textarea')
      area.value = text
      document.body.appendChild(area)
      area.select()
      document.execCommand('copy')
      area.remove()
    }
    setCopied(text)
    setTimeout(() => setCopied(null), 1600)
  }

  const linkList = (links: string[]) => (
    <ul className="link-list">
      {links.map((link) => (
        <li key={link}>
          <code>{link}</code>
          <button type="button" onClick={() => copy(link)}>
            {copied === link ? <Icon name="check" size={16} /> : <Icon name="copy" size={16} />}
          </button>
        </li>
      ))}
    </ul>
  )

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal wide" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <h1>{t('share.title')}</h1>
          <button type="button" onClick={onClose} aria-label={t('common.close')}>
            <Icon name="close" size={18} />
          </button>
        </div>
        <p className="modal-sub">{t('share.sub')}</p>

        <h3>{t('share.forClass')}</h3>
        {linkList(guestLinks)}

        {hostLinks.length > 0 && (
          <>
            <h3>{t('share.forCoHost')}</h3>
            {linkList(hostLinks)}
          </>
        )}

        {!info?.addresses.length && <p className="hint">{t('share.noAddress')}</p>}
      </div>
    </div>
  )
}

/* ------------------------------------------------------------------ */
/* Removed from the board                                              */
/* ------------------------------------------------------------------ */

export function KickedDialog({ reason }: { reason: string }) {
  useLang()
  return (
    <div className="modal-backdrop">
      <div className="modal">
        <h1>{t('kicked.title')}</h1>
        <p className="modal-sub">{reason}</p>
        <button type="button" className="primary" onClick={() => location.reload()}>
          {t('kicked.retry')}
        </button>
      </div>
    </div>
  )
}
