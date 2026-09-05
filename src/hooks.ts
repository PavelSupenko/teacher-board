import { useSyncExternalStore } from 'react'
import type { Session } from './net/session'

/** Re-renders when the document changes. */
export const useDoc = (session: Session): number =>
  useSyncExternalStore(session.store.subscribe, session.store.getSnapshot)

/** Re-renders when the network state changes: peers, rights, settings. */
export const useNet = (session: Session): number =>
  useSyncExternalStore(session.subscribe, session.getSnapshot)
