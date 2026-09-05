import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { BoardCanvas, type BoardCanvasHandle } from './components/BoardCanvas'
import { Toolbar } from './components/Toolbar'
import { StylePanel } from './components/StylePanel'
import { TopBar, type ExportRequest } from './components/TopBar'
import { PagesBar } from './components/PagesBar'
import { ParticipantsPanel } from './components/ParticipantsPanel'
import { JoinDialog, KickedDialog, ShareDialog } from './components/Dialogs'
import { DEFAULT_TOOLS, TOOL_HOTKEYS, type ToolSettings } from './model/tools'
import { Session } from './net/session'
import { useDoc, useNet } from './hooks'
import { t, useLang } from './i18n'
import type { BoardElement } from './model/types'
import { nanoid } from 'nanoid'

/** File name without characters that file systems refuse. */
const safeFileName = (s: string): string =>
  s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 80) || t('app.untitled')

const isTypingTarget = (el: EventTarget | null): boolean => {
  const node = el as HTMLElement | null
  return !!node && /^(INPUT|TEXTAREA|SELECT)$/.test(node.tagName)
}

export function App({ hostKey }: { hostKey: string | null }) {
  const [name, setName] = useState<string | null>(() => localStorage.getItem('tb:name'))
  const [session, setSession] = useState<Session | null>(null)

  const [tools, setTools] = useState<ToolSettings>(() => {
    try {
      const saved = localStorage.getItem('tb:tools')
      return saved ? { ...DEFAULT_TOOLS, ...JSON.parse(saved) } : DEFAULT_TOOLS
    } catch {
      return DEFAULT_TOOLS
    }
  })
  const [selection, setSelection] = useState<string[]>([])
  const [pageId, setPageId] = useState<string>('')
  const [zoom, setZoom] = useState(1)
  const [participantsOpen, setParticipantsOpen] = useState(false)
  const [shareOpen, setShareOpen] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const canvasRef = useRef<BoardCanvasHandle>(null)

  useEffect(() => {
    localStorage.setItem('tb:tools', JSON.stringify(tools))
  }, [tools])

  useEffect(() => {
    if (!name) return
    const s = new Session(name, hostKey)
    s.connect()
    setSession(s)
    return () => s.disconnect()
  }, [hostKey, name])

  if (!session) {
    return (
      <JoinDialog
        defaultName={name ?? (hostKey ? t('join.teacher') : '')}
        isHost={Boolean(hostKey)}
        onSubmit={(n) => {
          localStorage.setItem('tb:name', n)
          setName(n)
        }}
      />
    )
  }

  return (
    <Board
      session={session}
      hostKey={hostKey}
      tools={tools}
      setTools={setTools}
      selection={selection}
      setSelection={setSelection}
      pageId={pageId}
      setPageId={setPageId}
      zoom={zoom}
      setZoom={setZoom}
      participantsOpen={participantsOpen}
      setParticipantsOpen={setParticipantsOpen}
      shareOpen={shareOpen}
      setShareOpen={setShareOpen}
      busy={busy}
      setBusy={setBusy}
      canvasRef={canvasRef}
    />
  )
}

interface BoardProps {
  session: Session
  hostKey: string | null
  tools: ToolSettings
  setTools: React.Dispatch<React.SetStateAction<ToolSettings>>
  selection: string[]
  setSelection: React.Dispatch<React.SetStateAction<string[]>>
  pageId: string
  setPageId: React.Dispatch<React.SetStateAction<string>>
  zoom: number
  setZoom: React.Dispatch<React.SetStateAction<number>>
  participantsOpen: boolean
  setParticipantsOpen: React.Dispatch<React.SetStateAction<boolean>>
  shareOpen: boolean
  setShareOpen: React.Dispatch<React.SetStateAction<boolean>>
  busy: string | null
  setBusy: React.Dispatch<React.SetStateAction<string | null>>
  canvasRef: React.RefObject<BoardCanvasHandle | null>
}

function Board({
  session,
  hostKey,
  tools,
  setTools,
  selection,
  setSelection,
  pageId,
  setPageId,
  zoom,
  setZoom,
  participantsOpen,
  setParticipantsOpen,
  shareOpen,
  setShareOpen,
  busy,
  setBusy,
  canvasRef,
}: BoardProps) {
  useDoc(session)
  useNet(session)
  useLang()

  const doc = session.store.doc
  const { settings } = session

  /* ---------------- current sheet of the ribbon ---------------- */

  // The ribbon scrolls freely, so the "current page" is simply the one in
  // view. The canvas reports it; we only make sure it still exists.
  const effectivePageId = useMemo(() => {
    if (pageId && doc.pages.some((p) => p.id === pageId)) return pageId
    return doc.pages[0]?.id ?? ''
  }, [doc.pages, pageId])

  useEffect(() => {
    if (effectivePageId) session.setActivePage(effectivePageId)
  }, [effectivePageId, session])

  // In follow mode every participant's ribbon is pulled to the host's sheet.
  const followTarget = settings.followMode && !session.isHost ? settings.hostPageId : null
  useEffect(() => {
    if (followTarget) canvasRef.current?.scrollToPage(followTarget)
  }, [canvasRef, followTarget])

  // Drop from the selection whatever other participants have deleted.
  useEffect(() => {
    setSelection((sel) => (sel.some((id) => !doc.elements[id]) ? sel.filter((id) => doc.elements[id]) : sel))
  }, [doc, setSelection])

  /* ---------------- export ---------------- */

  const runExport = useCallback(
    async (req: ExportRequest) => {
      setBusy(t('export.busy'))
      // Give the button a frame to repaint before the heavy work starts.
      await new Promise((r) => setTimeout(r, 30))
      try {
        // jsPDF drags in large dependencies, so load it only on export.
        const { exportPdf, exportPng } = await import('./export/pdf')
        const theme = settings.theme
        const base = safeFileName(settings.roomName)
        const pageIndex = doc.pages.findIndex((p) => p.id === effectivePageId) + 1
        const pageLabel = t('export.pageSuffix', { n: pageIndex })
        if (req.kind === 'png') {
          await exportPng(doc, effectivePageId, theme, 2, `${base} — ${pageLabel}.png`, settings.paper)
          return
        }
        // Each mode gets its own file name; otherwise exports overwrite one
        // another in the downloads folder.
        const fileName =
          req.kind === 'pdf-page'
            ? `${base} — ${pageLabel}.pdf`
            : req.kind === 'pdf-raster'
              ? `${base} (${t('export.screenSuffix')}).pdf`
              : `${base}.pdf`
        await exportPdf(doc, {
          theme,
          paper: settings.paper,
          pageIds: req.kind === 'pdf-page' ? [effectivePageId] : undefined,
          raster: req.kind === 'pdf-raster',
          fileName,
        })
      } catch (err) {
        console.error(err)
        alert(t('export.failed', { message: (err as Error).message }))
      } finally {
        setBusy(null)
      }
    },
    [doc, effectivePageId, setBusy, settings.paper, settings.roomName, settings.theme],
  )

  /* ---------------- keyboard shortcuts ---------------- */

  const deleteSelection = useCallback(() => {
    const ids = selection.filter((id) => {
      const el = doc.elements[id]
      return el && session.canEditElement(el.authorId)
    })
    if (ids.length) session.store.commit({ t: 'remove', ids })
    setSelection([])
  }, [doc.elements, selection, session, setSelection])

  const duplicateSelection = useCallback(() => {
    const els = selection
      .map((id) => doc.elements[id])
      .filter((el): el is BoardElement => !!el)
    if (!els.length || !session.canDraw) return
    const ids: string[] = []
    session.store.transaction(() => {
      for (const el of els) {
        const copy = structuredClone(el)
        copy.id = nanoid(10)
        copy.authorId = session.selfId
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
    setSelection(ids)
  }, [doc.elements, selection, session, setSelection])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return
      const mod = e.ctrlKey || e.metaKey

      if (mod && e.key.toLowerCase() === 'z') {
        e.preventDefault()
        if (e.shiftKey) session.store.redo()
        else session.store.undo()
        return
      }
      if (mod && e.key.toLowerCase() === 'y') {
        e.preventDefault()
        session.store.redo()
        return
      }
      if (mod && e.key.toLowerCase() === 'a') {
        e.preventDefault()
        setSelection(session.store.elementsOf(effectivePageId).map((el) => el.id))
        setTools((t) => ({ ...t, tool: 'select' }))
        return
      }
      if (mod && e.key.toLowerCase() === 'd') {
        e.preventDefault()
        duplicateSelection()
        return
      }
      if (mod && (e.key === '=' || e.key === '+')) {
        e.preventDefault()
        canvasRef.current?.zoomBy(1.2)
        return
      }
      if (mod && e.key === '-') {
        e.preventDefault()
        canvasRef.current?.zoomBy(1 / 1.2)
        return
      }
      if (mod && e.key === '0') {
        e.preventDefault()
        canvasRef.current?.fit()
        return
      }
      if (mod) return

      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault()
        deleteSelection()
        return
      }
      if (e.key === 'Escape') {
        setSelection([])
        setTools((t) => ({ ...t, tool: 'select' }))
        return
      }
      const tool = TOOL_HOTKEYS[e.key.toLowerCase()]
      if (tool && !e.repeat) {
        if (!session.canDraw && tool !== 'select' && tool !== 'pan') return
        setTools((t) => ({ ...t, tool }))
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [canvasRef, deleteSelection, duplicateSelection, effectivePageId, session, setSelection, setTools])

  /* ---------------- layout ---------------- */

  if (session.status === 'kicked') {
    return <KickedDialog reason={session.statusMessage || t('kicked.reason')} />
  }

  return (
    <div className={`app theme-${settings.theme}`}>
      <TopBar
        session={session}
        canUndo={session.store.canUndo}
        canRedo={session.store.canRedo}
        onUndo={() => session.store.undo()}
        onRedo={() => session.store.redo()}
        onExport={runExport}
        onShare={() => setShareOpen(true)}
        onToggleParticipants={() => setParticipantsOpen((v) => !v)}
        participantsOpen={participantsOpen}
        busy={busy}
      />

      <div className="workspace">
        <div className="left-rail">
          <Toolbar
            tools={tools}
            setTools={setTools}
            disabled={!session.canDraw}
            onInsertImage={() => canvasRef.current?.pickImage()}
            canStylePaper={session.isHost}
          />
          <StylePanel
            session={session}
            tools={tools}
            setTools={setTools}
            selection={selection}
            onSelectionChange={setSelection}
            pageId={effectivePageId}
          />
        </div>

        <BoardCanvas
          ref={canvasRef}
          session={session}
          tools={tools}
          theme={settings.theme}
          selection={selection}
          onSelectionChange={setSelection}
          onZoomChange={setZoom}
          onRequestSelect={() => setTools((t) => ({ ...t, tool: 'select' }))}
          onActivePageChange={setPageId}
        />

        {participantsOpen && (
          <ParticipantsPanel session={session} onClose={() => setParticipantsOpen(false)} />
        )}
      </div>

      <PagesBar
        session={session}
        pageId={effectivePageId}
        onPageChange={(id) => canvasRef.current?.scrollToPage(id)}
        zoom={zoom}
        onZoomIn={() => canvasRef.current?.zoomBy(1.2)}
        onZoomOut={() => canvasRef.current?.zoomBy(1 / 1.2)}
        onFit={() => canvasRef.current?.fit()}
      />

      {shareOpen && <ShareDialog hostKey={hostKey} onClose={() => setShareOpen(false)} />}
    </div>
  )
}
