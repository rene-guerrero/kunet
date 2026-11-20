/**
 * Phone to phone without any network: Google Nearby Connections (Bluetooth / BLE, possibly upgraded to
 * Wi-Fi Direct by Nearby), through the KuLocal plugin. Android app only.
 *
 * The host advertises its room ("<code>|<name>"); joiners discover it and connect. Over the endpoint
 * link everything is a string, with a one-letter kind:
 *   O{"code","pid"}  joiner → host: open a room socket (replaces this endpoint's previous one)
 *   F<frame>         a whole game frame (both ways)
 *   P<part>          part of a longer frame, more follows (Nearby BYTES payloads are capped near 32 KB)
 *   X<code>          the room socket closed (either side), with its close code
 * A dropped endpoint closes the socket (1006); the game client reconnects as it does online.
 */
import type { PluginListenerHandle } from '@capacitor/core';
import { KuLocal as plugin } from './plugin';
import type { LocalHost } from './localHost';
import type { Backend, Conn, Link } from './types';

interface NearbyPlugin {
  nearbyPermission(o: { request?: boolean }): Promise<{ granted: boolean }>;
  nearbyAdvertise(o: { game: string; name: string; code: string }): Promise<void>;
  nearbyStopAdvertise(): Promise<void>;
  nearbyDiscover(o: { game: string }): Promise<void>;
  nearbyStopDiscovery(): Promise<void>;
  nearbyConnect(o: { id: string; name: string }): Promise<void>;
  nearbySend(o: { id: string; data: string }): Promise<void>;
  nearbyDisconnect(o: { id: string }): Promise<void>;
  nearbyStop(): Promise<void>;
  locationEnabled(): Promise<{ enabled: boolean }>;
  openLocationSettings(): Promise<void>;
  addListener(event: string, cb: (ev: any) => void): Promise<PluginListenerHandle>;
}

const KuLocal = plugin as NearbyPlugin;

/** characters per payload part (UTF-8 can take 3 bytes each: well under the ~32 KB cap) */
export const NEARBY_CHUNK = 8000;

/** split a frame into F / P messages */
export function frameParts(frame: string, chunk = NEARBY_CHUNK): string[] {
  if (frame.length <= chunk) return [`F${frame}`];
  const out: string[] = [];
  for (let i = 0; i < frame.length; i += chunk) {
    const last = i + chunk >= frame.length;
    out.push(`${last ? 'F' : 'P'}${frame.slice(i, i + chunk)}`);
  }
  return out;
}

/** reassembles F / P messages per endpoint; returns the whole frame when one completes */
export class Reassembler {
  private parts = new Map<string, string[]>();
  push(id: string, msg: string): string | null {
    const kind = msg[0];
    const body = msg.slice(1);
    if (kind === 'P') {
      const p = this.parts.get(id) ?? [];
      p.push(body);
      this.parts.set(id, p);
      return null;
    }
    if (kind !== 'F') return null;
    const p = this.parts.get(id);
    this.parts.delete(id);
    return p ? p.join('') + body : body;
  }
  drop(id: string): void {
    this.parts.delete(id);
  }
}

const sendFrame = (id: string, frame: string) => {
  for (const m of frameParts(frame)) void KuLocal.nearbySend({ id, data: m }).catch(() => {});
};

/** has the user allowed Nearby (Bluetooth / nearby devices)? request = show Android's prompt if not */
export async function nearbyPermission(request = false): Promise<boolean> {
  try {
    return (await KuLocal.nearbyPermission({ request })).granted;
  } catch {
    return false;
  }
}

/** is the phone's Location switched on? Nearby needs it to find phones over Bluetooth */
export async function locationEnabled(): Promise<boolean> {
  try {
    return (await KuLocal.locationEnabled()).enabled;
  } catch {
    return true;
  }
}

export const openLocationSettings = (): Promise<void> => KuLocal.openLocationSettings().catch(() => {});

/** Nearby's "missing location permission" codes, also what it reports when Location is switched off */
export const isLocationError = (message: string): boolean => /\b(8034|8033|8009)\b|LOCATION/i.test(message);

/** "7KQM|Teléfono de Ana" → code + name */
export function parseEndpointName(n: string): { code: string; name: string } {
  const i = n.indexOf('|');
  return i < 0 ? { code: '', name: n } : { code: n.slice(0, i), name: n.slice(i + 1) };
}

// ───────────────────────── one listener set for both roles ─────────────────────────

type Handler = {
  open?: (id: string, incoming: boolean) => void;
  data?: (id: string, data: string) => void;
  close?: (id: string) => void;
  found?: (id: string, name: string) => void;
  lost?: (id: string) => void;
};
const handlers = new Set<Handler>();
const errorHandlers = new Set<(where: string, message: string) => void>();

/** Nearby failures (advertise / discover / connect…) as they happen, e.g. to show them; returns unsubscribe */
export function onNearbyError(f: (where: string, message: string) => void): () => void {
  errorHandlers.add(f);
  void wire();
  return () => errorHandlers.delete(f);
}
let wired: Promise<void> | null = null;
function wire(): Promise<void> {
  wired ??= (async () => {
    await KuLocal.addListener('nearbyOpen', (e: { id: string; incoming: boolean }) => handlers.forEach((h) => h.open?.(e.id, e.incoming)));
    await KuLocal.addListener('nearbyData', (e: { id: string; data: string }) => handlers.forEach((h) => h.data?.(e.id, e.data)));
    await KuLocal.addListener('nearbyClose', (e: { id: string }) => handlers.forEach((h) => h.close?.(e.id)));
    await KuLocal.addListener('nearbyFound', (e: { id: string; name: string }) => handlers.forEach((h) => h.found?.(e.id, e.name)));
    await KuLocal.addListener('nearbyLost', (e: { id: string }) => handlers.forEach((h) => h.lost?.(e.id)));
    await KuLocal.addListener('nearbyError', (e: { where: string; message: string }) => {
      console.warn('[nearby]', e.where, e.message);
      errorHandlers.forEach((f) => f(e.where, e.message));
    });
  })();
  return wired;
}

// ───────────────────────── host ─────────────────────────

export interface NearbyHostHandle {
  /** start advertising a room (call again for another code) */
  advertise(code: string): Promise<void>;
  stop(): Promise<void>;
}

export async function startNearbyHost(host: LocalHost, o: { game: string; name: string; normalizeCode?: (s: string) => string }): Promise<NearbyHostHandle> {
  await wire();
  const norm = o.normalizeCode ?? ((s: string) => s.toUpperCase());
  const links = new Map<string, Link>();
  const asm = new Reassembler();
  const drop = (id: string) => {
    const l = links.get(id);
    links.delete(id);
    asm.drop(id);
    l?.onclose?.();
  };
  const h: Handler = {
    data: (id, msg) => {
      if (msg[0] === 'O') {
        drop(id); // a fresh socket from the same phone replaces the old one
        let open: { code?: unknown; pid?: unknown } = {};
        try {
          open = JSON.parse(msg.slice(1));
        } catch {
          /* bad open: room_not_found below */
        }
        let closed = false;
        const link: Link = {
          send: (d) => !closed && sendFrame(id, d),
          close: (code = 1000) => {
            if (closed) return;
            closed = true;
            void KuLocal.nearbySend({ id, data: `X${code}` }).catch(() => {});
            if (links.get(id) === link) drop(id);
          },
          onmessage: null,
          onclose: null,
        };
        links.set(id, link);
        host.connect(norm(String(open.code ?? '')), typeof open.pid === 'string' ? open.pid : null, link);
        return;
      }
      if (msg[0] === 'X') return drop(id);
      const frame = asm.push(id, msg);
      if (frame !== null) links.get(id)?.onmessage?.(frame);
    },
    close: (id) => drop(id),
  };
  handlers.add(h);
  return {
    advertise: (code) =>
      KuLocal.nearbyAdvertise({ game: o.game, name: o.name, code }).catch((e: unknown) => errorHandlers.forEach((f) => f('advertise', String((e as Error)?.message ?? e)))),
    stop: async () => {
      handlers.delete(h);
      for (const id of [...links.keys()]) drop(id);
      await KuLocal.nearbyStop().catch(() => {});
    },
  };
}

// ───────────────────────── discovery ─────────────────────────

export interface NearbyGame {
  id: string;
  code: string;
  name: string;
}

/** latest endpoint seen per room code (a host found again after a drop may have a new endpoint id) */
const lastSeen = new Map<string, string>();
let discoveries = 0;

async function startDiscovery(game: string): Promise<void> {
  if (discoveries++ === 0) await KuLocal.nearbyDiscover({ game }).catch((e: unknown) => errorHandlers.forEach((f) => f('discover', String((e as Error)?.message ?? e))));
}
function stopDiscovery(): void {
  if (discoveries > 0 && --discoveries === 0) void KuLocal.nearbyStopDiscovery().catch(() => {});
}

/** watch for hosts advertising `game` over Nearby (needs the permission); returns a stop function */
export function discoverNearby(game: string, onChange: (games: NearbyGame[]) => void): () => void {
  const found = new Map<string, NearbyGame>();
  let stopped = false;
  const h: Handler = {
    found: (id, name) => {
      const p = parseEndpointName(name);
      if (!p.code) return;
      lastSeen.set(p.code, id);
      found.set(id, { id, ...p });
      if (!stopped) onChange([...found.values()]);
    },
    lost: (id) => {
      if (found.delete(id) && !stopped) onChange([...found.values()]);
    },
  };
  void wire().then(() => {
    if (stopped) return;
    handlers.add(h);
    void startDiscovery(game);
  });
  return () => {
    if (stopped) return;
    stopped = true;
    if (handlers.delete(h)) stopDiscovery();
  };
}

// ───────────────────────── join ─────────────────────────

/** a Backend for the room `game.code` hosted by the phone at Nearby endpoint `game.id` */
export function nearbyBackend(gameId: string, target: NearbyGame, myName: string): Backend {
  return {
    createRoom: async () => {
      throw Object.assign(new Error('server'), { code: 'server' });
    },
    roomInfo: async (code) => (code === target.code ? { exists: true } : { exists: false }),
    connect: (code, pid) => {
      let closed = false;
      let opened = false;
      const asm = new Reassembler();
      let id = lastSeen.get(target.code) ?? target.id;
      const conn: Conn = {
        send: (d) => {
          if (!closed && opened) sendFrame(id, d);
        },
        close: (c = 1000) => {
          if (closed) return;
          closed = true;
          handlers.delete(h);
          if (opened) void KuLocal.nearbySend({ id, data: `X${c}` }).catch(() => {});
        },
        onopen: null,
        onmessage: null,
        onclose: null,
      };
      const fail = (c: number) => {
        if (closed) return;
        closed = true;
        // never reached the host: its endpoint id may be stale, search again on the next try
        if (!opened && lastSeen.get(target.code) === id) lastSeen.delete(target.code);
        handlers.delete(h);
        conn.onclose?.(c);
      };
      const h: Handler = {
        open: (eid, incoming) => {
          if (eid !== id || incoming || opened || closed) return;
          opened = true;
          void KuLocal.nearbySend({ id, data: `O${JSON.stringify({ code, pid })}` }).catch(() => {});
          conn.onopen?.();
        },
        data: (eid, msg) => {
          if (eid !== id || closed) return;
          if (msg[0] === 'X') return fail(Number(msg.slice(1)) || 1000);
          const frame = asm.push(eid, msg);
          if (frame !== null) conn.onmessage?.(frame);
        },
        close: (eid) => eid === id && fail(1006),
      };
      void (async () => {
        await wire();
        if (closed) return;
        handlers.add(h);
        // after a drop the host may come back under a new endpoint id: look for it briefly
        if (!lastSeen.has(target.code)) {
          const stop = discoverNearby(gameId, () => {});
          await new Promise((r) => setTimeout(r, 4000));
          stop();
          id = lastSeen.get(target.code) ?? id;
        }
        if (closed) return;
        await KuLocal.nearbyConnect({ id, name: myName }).catch(() => fail(1006));
        // no answer at all: give up so the client retries
        setTimeout(() => !opened && fail(1006), 20_000);
      })();
      return conn;
    },
  };
}

/** leave every Nearby link (the joiner left the room) */
export function nearbyDisconnectAll(): Promise<void> {
  lastSeen.clear();
  return KuLocal.nearbyStop().catch(() => {});
}
