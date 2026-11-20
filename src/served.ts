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
  /** origins other devices can reach (http://192.168.1.37:8787), best first */
  origins?: string[];
}

/**
 * The origin to put in join links and QR codes: this page's own origin, unless the page was opened on
 * the host machine itself (localhost), which other devices cannot reach — then the host's LAN address.
 */
export function joinOrigin(s: LocalServed, loc: { origin: string; hostname: string } = location): string {
  const loopback = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/.test(loc.hostname);
  return (loopback && s.origins?.[0]) || loc.origin;
}

export function localServed(game: string): LocalServed | null {
  const v = (globalThis as { __KUNET_LOCAL__?: LocalServed }).__KUNET_LOCAL__;
  return v && typeof v === 'object' && v.game === game ? v : null;
}
