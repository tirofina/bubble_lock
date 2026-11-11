import type { CSSProperties } from 'react';

const paths = {
  bubble: 'M12 3a9 9 0 0 0-7.6 13.8L3 21l4.3-1.4A9 9 0 1 0 12 3Z',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z',
  pin: 'M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 1 1 16 0ZM15 10a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z',
  key: 'M15 7a5 5 0 1 0 0 10 5 5 0 0 0 0-10ZM10 12H2m3 0v4m3-4v2',
  shield: 'm12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Zm-4 9 3 3 5-6',
  bolt: 'm13 2-9 12h7l-1 8 10-13h-7l1-7Z',
  activity: 'M2 12h5l3-8 4 16 3-8h5',
  bell: 'M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9Zm-8 12h4',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 10v-3a7 7 0 0 1 14 0v3m0-17a4 4 0 0 1 0 8m3 2a7 7 0 0 1 3 7',
  settings: 'M4 7h16M4 17h16M8 4v6m8 4v6',
  arrow: 'M4 12h16m-6-6 6 6-6 6',
  chevron: 'm9 5 7 7-7 7',
  refresh: 'M20 6v6h-6M4 18v-6h6m-4-5a8 8 0 0 1 13-1M5 18a8 8 0 0 0 13-1',
  check: 'm5 12 4 4L19 6',
  file: 'M5 3h9l5 5v13H5V3Zm9 0v6h5M8 13h8m-8 4h6',
  server: 'M3 3h18v7H3zM3 14h18v7H3zM6 6h.01M6 17h.01',
  exit: 'M9 3H3v18h6m4-16 7 7-7 7M8 12h12',
  plus: 'M12 4v16M4 12h16',
} as const;
export type IconName = keyof typeof paths;
export function Icon({ name, size = 20, style }: { name: IconName; size?: number; style?: CSSProperties }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" style={style}><path d={paths[name]} /></svg>;
}
