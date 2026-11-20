/**
 * Was this page served by a local host (the Node dev host or the Android app's Wi-Fi server)? The host
 * injects `window.__KUNET_LOCAL__` into index.html, so the answer is known synchronously at boot: the
 * game then talks to its own origin (`location.origin` serves the same /api/rooms routes as the Worker).
 */
export interface LocalServed {
  /** which game the host serves (a page of another game must not use it) */
  game: string;
  /** 'node' = the PC dev host, 'android' = a phone */
  kind: 'node' | 'android';
  /** the host's name to show ("Teléfono de Ana"), may be empty */
  name: string;
}

export function localServed(game: string): LocalServed | null {
  const v = (globalThis as { __KUNET_LOCAL__?: LocalServed }).__KUNET_LOCAL__;
  return v && typeof v === 'object' && v.game === game ? v : null;
}
