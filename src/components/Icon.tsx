const PATHS: Record<string, string> = {
  cursor: 'M5 3l14 8-6 1.6L10.4 19z',
  pen: 'M15.5 4.5l4 4M3 21l1.2-4.4L16.1 4.7a2 2 0 0 1 2.8 0l.4.4a2 2 0 0 1 0 2.8L7.4 19.8z',
  highlighter: 'M4 20h6M14 4.5l5.5 5.5M9 18l-3.5.5.5-3.5L15.8 4.7a1.7 1.7 0 0 1 2.4 0l1.1 1.1a1.7 1.7 0 0 1 0 2.4z',
  eraser: 'M9 21H6.5L3 17.5a2 2 0 0 1 0-2.8l9.7-9.7a2 2 0 0 1 2.8 0l5.5 5.5a2 2 0 0 1 0 2.8L12.5 21zM8 12l6 6M21 21h-9',
  text: 'M5 6V4h14v2M12 4v16M9 20h6',
  rect: 'M4 5h16v14H4z',
  ellipse: 'M12 5c4.4 0 8 3.1 8 7s-3.6 7-8 7-8-3.1-8-7 3.6-7 8-7z',
  line: 'M4 19L20 5',
  arrow: 'M4 19L20 5M20 5h-7M20 5v7',
  triangle: 'M12 4l9 16H3z',
  diamond: 'M12 3l9 9-9 9-9-9z',
  star: 'M12 3l2.7 5.7 6.3.8-4.6 4.3 1.2 6.2L12 17l-5.6 3 1.2-6.2L3 9.5l6.3-.8z',
  hand: 'M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-1.5V4.5a1.5 1.5 0 0 1 3 0V12m0-1V6.5a1.5 1.5 0 0 1 3 0V14a7 7 0 0 1-7 7h-1a6 6 0 0 1-6-6v-3.5a1.5 1.5 0 0 1 3 0V14',
  undo: 'M4 9h11a5 5 0 0 1 0 10h-5M4 9l4-4M4 9l4 4',
  redo: 'M20 9H9a5 5 0 0 0 0 10h5M20 9l-4-4M20 9l-4 4',
  trash: 'M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13M10 11v6M14 11v6',
  plus: 'M12 5v14M5 12h14',
  minus: 'M5 12h14',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  front: 'M12 3l8 4.5-8 4.5-8-4.5zM4 13l8 4.5 8-4.5M4 17.5L12 22l8-4.5',
  back: 'M12 22l-8-4.5 8-4.5 8 4.5zM20 11L12 6.5 4 11M20 6.5L12 2 4 6.5',
  download: 'M12 3v12M7 11l5 5 5-5M4 20h16',
  users: 'M16 20v-1.5a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4V20M9 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM22 20v-1.5a4 4 0 0 0-3-3.9M16 3.6a4 4 0 0 1 0 7.7',
  lock: 'M6 11h12v9H6zM9 11V7a3 3 0 0 1 6 0v4',
  unlock: 'M6 11h12v9H6zM9 11V7a3 3 0 0 1 5.8-1',
  eye: 'M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  grid: 'M4 4h16v16H4zM4 9.5h16M4 15h16M9.5 4v16M15 4v16',
  chevronDown: 'M6 9l6 6 6-6',
  chevronUp: 'M6 15l6-6 6 6',
  close: 'M6 6l12 12M18 6L6 18',
  check: 'M4 12.5l5 5L20 6.5',
  share: 'M18 8a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM6 15a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM18 21a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM8.2 11.4l7.6-3.8M8.2 13.6l7.6 3.8',
  image: 'M4 5h16v14H4zM4 16l4.5-4.5 4 4L16 12l4 4M9 9.5a1 1 0 1 0 0-2 1 1 0 0 0 0 2z',
  page: 'M6 3h8l4 4v14H6zM14 3v4h4',
  fit: 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
  crown: 'M4 18h16M4 18l-1-9 5.5 4L12 5l3.5 8L21 9l-1 9',
  follow: 'M12 5v14M5 12h14M12 5l-3 3M12 5l3 3M12 19l-3-3M12 19l3-3',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7.1 19.4l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.6 1.6 0 0 0 3 13.9H3a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 4.6 7.1l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9.3A1.6 1.6 0 0 0 10.3 3.1V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 2.7 1.1l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8v.1a1.6 1.6 0 0 0 1.5 1h.1a2 2 0 1 1 0 4H21a1.6 1.6 0 0 0-1.5 1z',
}

export type IconName = keyof typeof PATHS

export function Icon({
  name,
  size = 20,
  filled = false,
}: {
  name: IconName | string
  size?: number
  filled?: boolean
}) {
  const d = PATHS[name] ?? PATHS.cursor
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={d} />
    </svg>
  )
}
