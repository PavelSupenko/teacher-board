import { useSyncExternalStore } from 'react'
import { en } from './en'
import { uk } from './uk'

export type Lang = 'en' | 'uk'
export type MessageKey = keyof typeof en

export const LANGUAGES: { id: Lang; label: string; short: string }[] = [
  { id: 'en', label: 'English', short: 'EN' },
  { id: 'uk', label: 'Українська', short: 'UK' },
]

const DICTIONARIES: Record<Lang, Record<MessageKey, string>> = { en, uk }
const STORAGE_KEY = 'tb:lang'

const isLang = (value: unknown): value is Lang => value === 'en' || value === 'uk'

/** Saved choice first, then the browser's preference, then English. */
function detect(): Lang {
  try {
    const saved = localStorage.getItem(STORAGE_KEY)
    if (isLang(saved)) return saved
  } catch {
    /* storage may be unavailable in a private window */
  }
  const preferred = typeof navigator !== 'undefined' ? navigator.languages ?? [] : []
  for (const tag of preferred) {
    const base = tag.toLowerCase().split('-')[0]
    if (base === 'uk') return 'uk'
    if (base === 'en') return 'en'
  }
  return 'en'
}

let current: Lang = detect()
const listeners = new Set<() => void>()

function applyToDocument() {
  if (typeof document !== 'undefined') document.documentElement.lang = current
}
applyToDocument()

export const getLang = (): Lang => current

export function setLang(lang: Lang) {
  if (lang === current) return
  current = lang
  try {
    localStorage.setItem(STORAGE_KEY, lang)
  } catch {
    /* nothing to do if storage is blocked */
  }
  applyToDocument()
  for (const fn of listeners) fn()
}

const subscribe = (fn: () => void) => {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

/**
 * Looks up a message and fills in {placeholders}.
 * Unknown keys fall back to English and then to the key itself, so a missing
 * translation shows up as readable text instead of an empty label.
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template = DICTIONARIES[current][key] ?? en[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in vars ? String(vars[name]) : whole,
  )
}

/** Re-renders the component when the language changes. */
export function useLang(): Lang {
  return useSyncExternalStore(subscribe, getLang, getLang)
}
