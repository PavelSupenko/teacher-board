import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import './styles.css'

const params = new URLSearchParams(location.search)
// The host key arrives in the link; strip it from the address bar so it does
// not end up in browser history or leak while sharing a screen.
const urlKey = params.get('key')
if (urlKey) {
  sessionStorage.setItem('tb:key', urlKey)
  params.delete('key')
  const rest = params.toString()
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''))
}
// A name can be passed in the link, which is handy for prepared invitations.
const urlName = params.get('name')
if (urlName) {
  localStorage.setItem('tb:name', urlName.slice(0, 40))
  params.delete('name')
  const rest = params.toString()
  history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : ''))
}

const hostKey = urlKey ?? sessionStorage.getItem('tb:key')

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App hostKey={hostKey} />
  </StrictMode>,
)
