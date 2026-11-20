/**
 * The JS half of the Android plugin, against a fake KuLocal: the Wi-Fi host turns plugin events into
 * LocalHost calls (api routes, links), and nativeBackend turns a Conn into plugin client calls.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreIO, MakeCore, RoomCoreLike } from '../src';

const fake = vi.hoisted(() => {
  const listeners = new Map<string, Set<(e: any) => void>>();
  const calls: { m: string; o: any }[] = [];
  const fire = (ev: string, data: any) => listeners.get(ev)?.forEach((f) => f(data));
  let nextClient = 1;
  const plugin: Record<string, any> = new Proxy(
    {},
    {
      get(_t, m: string) {
        if (m === 'addListener')
          return async (ev: string, cb: (e: any) => void) => {
            if (!listeners.has(ev)) listeners.set(ev, new Set());
            listeners.get(ev)!.add(cb);
            return { remove: async () => listeners.get(ev)!.delete(cb) };
          };
        if (m === 'then') return undefined;
        return async (o: any) => {
          calls.push({ m, o });
          if (m === 'startServer') return { port: 8787, origins: ['http://192.168.1.50:8787'] };
          if (m === 'connect') return { id: nextClient++ };
          if (m === 'request') {
            if (o.url.endsWith('/api/rooms/ZZZZ')) return { status: 200, body: '{"exists":false}' };
            if (o.url.includes('/api/rooms?')) return { status: 201, body: '{"code":"QWER"}' };
            return { status: 200, body: '{"exists":true,"phase":"lobby","freeSeats":2}' };
          }
          return undefined;
        };
      },
    },
  );
  return { listeners, calls, fire, plugin, reset: () => { listeners.clear(); calls.length = 0; } };
});

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => fake.plugin,
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => true },
}));

const { LocalHost } = await import('../src');
const { startWifiHost, nativeBackend, nativeLocalAvailable, discoverHosts } = await import('../src/native');

/** echo room: hello → welcome, anything else echoed */
const echoCore: MakeCore = <S,>(io: CoreIO<S>): RoomCoreLike<S> => {
  const core: RoomCoreLike<S> = {
    data: null,
    create: (code) => ((core.data = { code }), true),
    info: () => ({ exists: !!core.data, phase: 'lobby', freeSeats: 3 }),
    accept: (s, pid) => io.setAttachment(s, { pid, hello: false }),
    message: (s, raw) => io.send(s, { echo: JSON.parse(String(raw)) }),
    socketGone: () => {},
    alarm: () => {},
    nextAlarm: () => null,
  };
  return core;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('kunet/native', () => {
  beforeEach(() => fake.reset());

  it('is available on Android with the plugin', () => {
    expect(nativeLocalAvailable()).toBe(true);
  });

  it('Wi-Fi host: answers the api routes and carries link frames', async () => {
    const host = new LocalHost(echoCore, { codes: { alphabet: 'ABCD', length: 4 } });
    const wifi = await startWifiHost(host, { game: 'kudominoes', name: 'Teléfono' });
    expect(wifi.origins).toEqual(['http://192.168.1.50:8787']);
    expect(fake.calls.find((c) => c.m === 'startServer')!.o).toMatchObject({ game: 'kudominoes', name: 'Teléfono' });

    fake.fire('api', { rid: 1, method: 'POST', path: '/api/rooms', query: { pid: 'pid-1' } });
    const created = fake.calls.find((c) => c.m === 'apiRespond' && c.o.rid === 1)!.o;
    expect(created.status).toBe(201);
    const code = JSON.parse(created.json).code as string;
    fake.fire('api', { rid: 2, method: 'GET', path: `/api/rooms/${code}`, query: {} });
    expect(JSON.parse(fake.calls.find((c) => c.o?.rid === 2)!.o.json)).toEqual({ exists: true, phase: 'lobby', freeSeats: 3 });
    fake.fire('api', { rid: 9, method: 'GET', path: '/api/rooms', query: {} });
    expect(JSON.parse(fake.calls.find((c) => c.o?.rid === 9)!.o.json)).toEqual({ rooms: [{ code, exists: true, phase: 'lobby', freeSeats: 3 }] });
    fake.fire('api', { rid: 3, method: 'GET', path: '/nope', query: {} });
    expect(fake.calls.find((c) => c.o?.rid === 3)!.o.status).toBe(404);

    fake.fire('linkOpen', { id: 7, code, pid: 'pid-1' });
    fake.fire('linkMessage', { id: 7, data: '{"t":"hi"}' });
    const sent = fake.calls.filter((c) => c.m === 'send' && c.o.id === 7).map((c) => JSON.parse(c.o.data));
    expect(sent).toEqual([{ echo: { t: 'hi' } }]);
    fake.fire('linkClose', { id: 7 });

    // an unknown room: room_not_found, then close 4004
    fake.fire('linkOpen', { id: 8, code: 'DDDD', pid: null });
    expect(fake.calls.some((c) => c.m === 'send' && c.o.id === 8 && c.o.data.includes('room_not_found'))).toBe(true);
    expect(fake.calls.some((c) => c.m === 'close' && c.o.id === 8 && c.o.code === 4004)).toBe(true);

    await wifi.advertise(code);
    expect(fake.calls.find((c) => c.m === 'advertise')!.o).toEqual({ type: 'kudominoes', name: 'Teléfono', code, port: 8787 });
    await wifi.stop();
    expect(fake.calls.some((c) => c.m === 'stopServer')).toBe(true);
    expect(fake.listeners.get('linkOpen')!.size).toBe(0);
  });

  it('nativeBackend: http through the plugin, a Conn over the native WebSocket client', async () => {
    const be = nativeBackend('http://192.168.1.50:8787/');
    expect(await be.createRoom('pid-2')).toBe('QWER');
    expect(await be.roomInfo('ZZZZ')).toEqual({ exists: false });
    expect(await be.roomInfo('QWER')).toEqual({ exists: true, phase: 'lobby', freeSeats: 2 });

    const conn = be.connect('QWER', 'pid-2');
    const got: string[] = [];
    let opened = false;
    let closedWith = 0;
    conn.onopen = () => (opened = true);
    conn.onmessage = (d) => got.push(d);
    conn.onclose = (c) => (closedWith = c);
    conn.send('early'); // before the socket exists: queued
    await tick();
    await tick();
    const connect = fake.calls.find((c) => c.m === 'connect')!;
    expect(connect.o.url).toBe('ws://192.168.1.50:8787/api/rooms/QWER/ws?pid=pid-2');
    const id = 1;
    expect(fake.calls.some((c) => c.m === 'clientSend' && c.o.id === id && c.o.data === 'early')).toBe(true);
    fake.fire('clientOpen', { id });
    fake.fire('clientMessage', { id, data: 'hello' });
    expect(opened).toBe(true);
    expect(got).toEqual(['hello']);
    fake.fire('clientClose', { id, code: 4001 });
    expect(closedWith).toBe(4001);
  });

  it('discoverHosts lists found hosts and drops lost ones', async () => {
    const seen: string[][] = [];
    const stop = discoverHosts('kudominoes', (hosts) => seen.push(hosts.map((h) => `${h.name}:${h.code}@${h.origin}`)));
    await tick();
    fake.fire('found', { key: 'Ana · 7KQM', host: '192.168.1.9', port: 8787, code: '7KQM', name: 'Ana' });
    fake.fire('lost', { key: 'Ana · 7KQM' });
    expect(seen).toEqual([['Ana:7KQM@http://192.168.1.9:8787'], []]);
    stop();
    expect(fake.calls.some((c) => c.m === 'stopDiscovery')).toBe(true);
  });
});

