/**
 * Local play inside the Android app, through the KuLocal plugin (android/ in this package).
 *
 *  - startWifiHost(host): the phone serves the game's own web build and the room routes on its Wi-Fi /
 *    hotspot address; every joiner's socket becomes a Link into `host` (the room runs here, in JS).
 *  - nativeBackend(origin): the app joining another device. Its page is https://localhost, so plain
 *    `fetch('http://…')` / `new WebSocket('ws://…')` to the LAN are mixed content; the plugin's native
 *    client carries them instead.
 *  - discoverHosts(game): hosts nearby on the same network (NSD / mDNS), each with its room code.
 */
import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { KuLocal as plugin } from './plugin';
import type { LocalHost } from './localHost';
import type { Backend, Conn, Link, RoomInfo } from './types';

interface KuLocalPlugin {
  startServer(o: { port?: number; game: string; name: string }): Promise<{ port: number; origins: string[] }>;
  stopServer(): Promise<void>;
  apiRespond(o: { rid: number; status: number; json: string }): Promise<void>;
  send(o: { id: number; data: string }): Promise<void>;
  close(o: { id: number; code?: number; reason?: string }): Promise<void>;
  keepAwake(o: { on: boolean }): Promise<void>;
  getAddresses(): Promise<{ addresses: { name: string; address: string }[] }>;
  advertise(o: { type: string; name: string; code: string; port: number }): Promise<void>;
  stopAdvertise(): Promise<void>;
  discover(o: { type: string }): Promise<void>;
  stopDiscovery(): Promise<void>;
  request(o: { method: string; url: string; timeoutMs?: number }): Promise<{ status: number; body: string }>;
  connect(o: { url: string; timeoutMs?: number }): Promise<{ id: number }>;
  clientSend(o: { id: number; data: string }): Promise<void>;
  clientClose(o: { id: number; code?: number; reason?: string }): Promise<void>;
  addListener(event: string, cb: (ev: any) => void): Promise<PluginListenerHandle>;
}

const KuLocal = plugin as KuLocalPlugin;

/** the app can host and join local games (Android build with the plugin) */
export function nativeLocalAvailable(): boolean {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('KuLocal');
  } catch {
    return false;
  }
}

export const keepAwake = (on: boolean): Promise<void> => KuLocal.keepAwake({ on }).catch(() => {});

// ───────────────────────── host ─────────────────────────

export interface WifiHost {
  port: number;
  /** origins other devices open (best first); empty = no Wi-Fi / hotspot address */
  origins: string[];
  /** announce a room to "Partidas cercanas" on other phones */
  advertise(code: string): Promise<void>;
  stop(): Promise<void>;
}

export interface WifiHostOptions {
  game: string;
  /** shown to joiners ("Teléfono de Ana") */
  name: string;
  port?: number;
  normalizeCode?: (raw: string) => string;
}

const json = (status: number, body: unknown) => ({ status, json: JSON.stringify(body) });

export async function startWifiHost(host: LocalHost, o: WifiHostOptions): Promise<WifiHost> {
  const links = new Map<number, Link>();
  const norm = o.normalizeCode ?? ((s: string) => s.toUpperCase());
  const handles: PluginListenerHandle[] = [];
  const on = async (ev: string, cb: (e: any) => void) => handles.push(await KuLocal.addListener(ev, cb));

  await on('linkOpen', (e: { id: number; code: string; pid: string | null }) => {
    const id = e.id;
    const link: Link = {
      send: (data) => void KuLocal.send({ id, data }).catch(() => {}),
      close: (code = 1000, reason = '') => void KuLocal.close({ id, code, reason }).catch(() => {}),
      onmessage: null,
      onclose: null,
    };
    links.set(id, link);
    host.connect(norm(e.code), e.pid ?? null, link);
  });
  await on('linkMessage', (e: { id: number; data: string }) => links.get(e.id)?.onmessage?.(e.data));
  await on('linkClose', (e: { id: number }) => {
    const l = links.get(e.id);
    links.delete(e.id);
    l?.onclose?.();
  });
  // the same routes as the Worker
  await on('api', (e: { rid: number; method: string; path: string; query: Record<string, string> }) => {
    const parts = e.path.replace(/\/+$/, '').split('/').filter(Boolean);
    let r: { status: number; json: string };
    try {
      if (parts[0] !== 'api' || parts[1] !== 'rooms') r = json(404, { error: 'not_found' });
      else if (parts.length === 2) r = e.method === 'POST' ? json(201, { code: host.createRoom(e.query.pid ?? null) }) : json(200, { rooms: host.list() });
      else if (parts.length === 3 && e.method === 'GET') {
        const code = norm(decodeURIComponent(parts[2]));
        r = json(200, code ? host.roomInfo(code) : { exists: false });
      } else r = json(404, { error: 'not_found' });
    } catch (err) {
      r = json(503, { error: (err as { code?: string })?.code ?? 'internal' });
    }
    void KuLocal.apiRespond({ rid: e.rid, ...r });
  });

  let started: { port: number; origins: string[] };
  try {
    started = await KuLocal.startServer({ port: o.port ?? 8787, game: o.game, name: o.name });
  } catch (e) {
    for (const h of handles) void h.remove();
    throw e;
  }
  return {
    port: started.port,
    origins: started.origins,
    advertise: (code) => KuLocal.advertise({ type: o.game, name: o.name, code, port: started.port }).catch(() => {}),
    stop: async () => {
      await KuLocal.stopAdvertise().catch(() => {});
      await KuLocal.stopServer().catch(() => {});
      for (const l of links.values()) l.onclose?.();
      links.clear();
      for (const h of handles) await h.remove();
    },
  };
}

// ───────────────────────── join ─────────────────────────

/** client events can arrive before connect() resolves with the id: keep them briefly */
const conns = new Map<number, Conn>();
const early = new Map<number, (() => void)[]>();
let clientWired: Promise<void> | null = null;

function wireClient(): Promise<void> {
  clientWired ??= (async () => {
    const route = (id: number, f: (c: Conn) => void) => {
      const c = conns.get(id);
      if (c) return f(c);
      const q = early.get(id) ?? [];
      q.push(() => {
        const c2 = conns.get(id);
        if (c2) f(c2);
      });
      early.set(id, q);
    };
    await KuLocal.addListener('clientOpen', (e: { id: number }) => route(e.id, (c) => c.onopen?.()));
    await KuLocal.addListener('clientMessage', (e: { id: number; data: string }) => route(e.id, (c) => c.onmessage?.(e.data)));
    await KuLocal.addListener('clientClose', (e: { id: number; code: number }) =>
      route(e.id, (c) => {
        conns.delete(e.id);
        c.onclose?.(e.code);
      }),
    );
  })();
  return clientWired;
}

export class LocalNetError extends Error {
  constructor(readonly code: 'offline' | 'server' | 'room_not_found') {
    super(code);
  }
}

async function req<T>(method: string, url: string): Promise<T> {
  let r: { status: number; body: string };
  try {
    r = await KuLocal.request({ method, url, timeoutMs: 5000 });
  } catch {
    throw new LocalNetError('offline');
  }
  if (r.status === 404) throw new LocalNetError('room_not_found');
  if (r.status < 200 || r.status >= 300) throw new LocalNetError('server');
  try {
    return JSON.parse(r.body) as T;
  } catch {
    throw new LocalNetError('server');
  }
}

/** a Backend for rooms hosted by another device at `origin` (http://192.168.1.37:8787) */
export function nativeBackend(origin: string): Backend {
  const base = origin.replace(/\/+$/, '');
  return {
    createRoom: async (pid) => (await req<{ code: string }>('POST', `${base}/api/rooms?pid=${encodeURIComponent(pid)}`)).code,
    roomInfo: async (code) => {
      try {
        return await req<RoomInfo>('GET', `${base}/api/rooms/${code}`);
      } catch (e) {
        if (e instanceof LocalNetError && e.code === 'room_not_found') return { exists: false };
        throw e;
      }
    },
    connect: (code, pid) => {
      let id: number | null = null;
      let closed = false;
      const pending: string[] = [];
      const conn: Conn = {
        send: (d) => {
          if (closed) return;
          if (id === null) pending.push(d);
          else void KuLocal.clientSend({ id, data: d }).catch(() => {});
        },
        close: (c = 1000, r = '') => {
          if (closed) return;
          closed = true;
          if (id !== null) void KuLocal.clientClose({ id, code: c, reason: r }).catch(() => {});
        },
        onopen: null,
        onmessage: null,
        onclose: null,
      };
      void (async () => {
        try {
          await wireClient();
          const r = await KuLocal.connect({ url: `${base.replace(/^http/, 'ws')}/api/rooms/${code}/ws?pid=${encodeURIComponent(pid)}`, timeoutMs: 6000 });
          id = r.id;
          conns.set(id, conn);
          if (closed) return void KuLocal.clientClose({ id, code: 1000 }).catch(() => {});
          for (const d of pending.splice(0)) void KuLocal.clientSend({ id, data: d });
          for (const f of early.get(id) ?? []) f();
          early.delete(id);
        } catch {
          if (!closed) conn.onclose?.(1006);
        }
      })();
      return conn;
    },
  };
}

// ───────────────────────── discovery ─────────────────────────

export interface NearbyHost {
  key: string;
  name: string;
  code: string;
  origin: string;
}

/** watch for hosts of `game` on this network; returns a stop function */
export function discoverHosts(game: string, onChange: (hosts: NearbyHost[]) => void): () => void {
  const found = new Map<string, NearbyHost>();
  const handles: Promise<PluginListenerHandle>[] = [];
  let stopped = false;
  const emit = () => !stopped && onChange([...found.values()]);
  handles.push(
    KuLocal.addListener('found', (e: { key: string; host: string; port: number; code: string; name: string }) => {
      found.set(e.key, { key: e.key, name: e.name, code: e.code, origin: `http://${e.host}:${e.port}` });
      emit();
    }),
  );
  handles.push(
    KuLocal.addListener('lost', (e: { key: string }) => {
      if (found.delete(e.key)) emit();
    }),
  );
  void KuLocal.discover({ type: game }).catch(() => {});
  return () => {
    stopped = true;
    void KuLocal.stopDiscovery().catch(() => {});
    for (const h of handles) void h.then((x) => x.remove());
  };
}

export * from './nearby';
