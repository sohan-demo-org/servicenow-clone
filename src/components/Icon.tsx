const PATHS: Record<string, string> = {
  search: 'M11 4a7 7 0 1 0 4.2 12.6l4.6 4.6 1.4-1.4-4.6-4.6A7 7 0 0 0 11 4zm0 2a5 5 0 1 1 0 10 5 5 0 0 1 0-10z',
  menu: 'M3 6h18v2H3zm0 5h18v2H3zm0 5h18v2H3z',
  star: 'M12 3l2.7 5.6 6.3.9-4.5 4.3 1 6.2L12 17l-5.6 3 1.1-6.2L3 9.5l6.3-.9z',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 2a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm-1 2v6l5 3 1-1.6-4-2.4V7z',
  bell: 'M12 22a2 2 0 0 0 2-2h-4a2 2 0 0 0 2 2zm6-6V11a6 6 0 0 0-5-5.9V4a1 1 0 0 0-2 0v1.1A6 6 0 0 0 6 11v5l-2 2v1h16v-1z',
  help: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm0 14a1.2 1.2 0 1 1 0-2.4 1.2 1.2 0 0 1 0 2.4zm1.2-4.6V13h-2.2v-1.4c0-1.6 2.4-1.9 2.4-3.3 0-.8-.6-1.4-1.5-1.4-.8 0-1.4.5-1.6 1.3l-2-.6C8.7 6 10.2 5 12 5c2.1 0 3.6 1.3 3.6 3.2 0 2.1-2.4 2.6-2.4 4.2z',
  chevronRight: 'M9 6l6 6-6 6-1.4-1.4L12.2 12 7.6 7.4z',
  chevronDown: 'M6 9l6 6 6-6-1.4-1.4L12 12.2 7.4 7.6z',
  chevronLeft: 'M15 6l-6 6 6 6 1.4-1.4L11.8 12l4.6-4.6z',
  filter: 'M3 5h18l-7 8v6l-4 2v-8z',
  plus: 'M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z',
  info: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zm1 14h-2v-6h2zm0-8h-2V7h2z',
  close: 'M6.4 5l5.6 5.6L17.6 5 19 6.4 13.4 12l5.6 5.6-1.4 1.4-5.6-5.6L6.4 19 5 17.6l5.6-5.6L5 6.4z',
  laptop: 'M4 5h16v10H4zm-2 12h20v2H2z',
  phone: 'M8 2h8a2 2 0 0 1 2 2v16a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2zm0 3v13h8V5z',
  monitor: 'M3 4h18v12H3zm6 14h6v2H9z',
  headset: 'M12 3a8 8 0 0 0-8 8v6a3 3 0 0 0 3 3h2v-7H6v-2a6 6 0 0 1 12 0v2h-3v7h2a3 3 0 0 0 3-3v-6a8 8 0 0 0-8-8z',
  software: 'M4 4h16v16H4zm2 4v10h12V8z',
  key: 'M7 14a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm5.6-4A6 6 0 1 0 12.6 14H15v2h2v-2h2v-4z',
  database: 'M12 3c4.4 0 8 1.3 8 3v12c0 1.7-3.6 3-8 3s-8-1.3-8-3V6c0-1.7 3.6-3 8-3zm0 2c-3.5 0-6 1-6 1s2.5 1 6 1 6-1 6-1-2.5-1-6-1z',
  shield: 'M12 2l8 3v6c0 5-3.4 9.4-8 11-4.6-1.6-8-6-8-11V5z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zm0 2c-4 0-8 2-8 5v1h16v-1c0-3-4-5-8-5z',
  video: 'M3 6h12v12H3zm13 4l5-3v10l-5-3z',
  book: 'M5 3h11a3 3 0 0 1 3 3v15H7a2 2 0 0 1-2-2zm2 14v2h10v-2z',
  cart: 'M7 18a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm10 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM3 3h3l2.7 10.5h9.6L21 6H7.2',
  wrench: 'M21 7a5 5 0 0 1-6.6 4.7L6 20l-2-2 8.3-8.4A5 5 0 0 1 17 3l-3 3 1 3 3 1z',
  list: 'M4 5h2v2H4zm4 0h12v2H8zM4 11h2v2H4zm4 0h12v2H8zm-4 6h2v2H4zm4 0h12v2H8z',
  logout: 'M10 4H5v16h5v-2H7V6h3zm6 4l-1.4 1.4 1.6 1.6H9v2h7.2l-1.6 1.6L16 16l4-4z',
  check: 'M9 16.2l-4.2-4.2-1.4 1.4L9 19 21 7l-1.4-1.4z',
  more: 'M5 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm7 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4z',
  attach: 'M16 6v10a4 4 0 0 1-8 0V5a2.5 2.5 0 0 1 5 0v10a1 1 0 0 1-2 0V6H9.5v9a2.5 2.5 0 0 0 5 0V5a4 4 0 0 0-8 0v11a5.5 5.5 0 0 0 11 0V6z',
  server: 'M4 4h16v6H4zm0 8h16v6H4zM7 6v2h2V6zm0 8v2h2v-2z',
  network: 'M3 9h18v6H3zM6 11v2h2v-2zM10 11v2h2v-2zM14 11v2h2v-2zM11 4h2v5h-2z',
  cloud: 'M7 19a5 5 0 0 1-.6-10A6 6 0 0 1 18 10a4.5 4.5 0 0 1-.5 9z',
  map: 'M5 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm14 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM12 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM5 17a2 2 0 1 0 0 4 2 2 0 0 0 0-4zm14 0a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM6 6.2l5 4.6-.9 1-5-4.6zm12 0l.9 1-5 4.6-.9-1zM11.1 13.2l.9 1-5 4.6-.9-1zm1.8 0l5 4.6-.9 1-5-4.6z',
  bolt: 'M13 2L4 14h7l-1 8 9-12h-7z',
  thumb: 'M2 21h4V9H2zm20-11a2 2 0 0 0-2-2h-6.3l1-4.6V3l-1.1-1L7 8.6V21h10a2 2 0 0 0 1.8-1.2l3-7a2 2 0 0 0 .2-.8z',
}

export function Icon({ name, size = 16, className }: { name: string; size?: number; className?: string }) {
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d={PATHS[name] ?? PATHS.info} />
    </svg>
  )
}
