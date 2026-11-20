/**
 * The JS half of Bluetooth play (Nearby Connections) against a fake KuLocal plugin: framing and
 * chunking, the host turning endpoint messages into LocalHost links, and the joiner's Conn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CoreIO, MakeCore, RoomCoreLike } from '../src';

const fake = vi.hoisted(() => {
  const listeners = new Map<string, Set<(e: any) => void>>();
  const calls: { m: string; o: any }[] = [];
  let granted = true;
  const fire = (ev: string, data: any) => listeners.get(ev)?.forEach((f) => f(data));
  const plugin: Record<string, any> = new Proxy(
    {},
    {
      get(_t, m: string) {
        if (m === 'then') return undefined;
        if (m === 'addListener')
          return async (ev: string, cb: (e: any) => void) => {
            if (!listeners.has(ev)) listeners.set(ev, new Set());
            listeners.get(ev)!.add(cb);
            return { remove: async () => listeners.get(ev)!.delete(cb) };
          };
        return async (o: any) => {
          calls.push({ m, o });
          if (m === 'nearbyPermission') {
            if (o?.request) granted = true;
            return { granted };
          }
          return undefined;
        };
      },
    },
  );
  return {
    calls,
    fire,
    plugin,
    deny: () => (granted = false),
    reset: () => {
      calls.length = 0;
      granted = true;
    },
  };
});

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => fake.plugin,
  Capacitor: { isNativePlatform: () => true, getPlatform: () => 'android', isPluginAvailable: () => true },
}));

const { LocalHost } = await import('../src');
const { frameParts, Reassembler, startNearbyHost, nearbyBackend, discoverNearby, nearbyPermission, parseEndpointName } = await import('../src/nearby');

const echoCore: MakeCore = <S,>(io: CoreIO<S>): RoomCoreLike<S> => {
  const core: RoomCoreLike<S> = {
    data: null,
    create: (code) => ((core.data = { code }), true),
    info: () => ({ exists: !!core.data }),
    accept: (s, pid) => io.setAttachment(s, { pid, hello: false }),
    message: (s, raw) => io.send(s, { echo: JSON.parse(String(raw)) }),
    socketGone: () => {},
    alarm: () => {},
    nextAlarm: () => null,
  };
  return core;
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const sent = (id: string) => fake.calls.filter((c) => c.m === 'nearbySend' && c.o.id === id).map((c) => c.o.data as string);

describe('Nearby framing', () => {
  it('splits long frames into parts and puts them back together', () => {
    const long = 'x'.repeat(20_000) + 'ñ';
    const parts = frameParts(long, 8000);
    expect(parts.map((p) => p[0])).toEqual(['P', 'P', 'F']);
    const r = new Reassembler();
    expect(r.push('e1', parts[0])).toBeNull();
    expect(r.push('e1', parts[1])).toBeNull();
    expect(r.push('e1', parts[2])).toBe(long);
    expect(frameParts('{"t":"ping"}')).toEqual(['F{"t":"ping"}']);
    expect(parseEndpointName('7KQM|Teléfono de Ana')).toEqual({ code: '7KQM', name: 'Teléfono de Ana' });
  });
});

describe('Nearby host and joiner', () => {
  beforeEach(() => fake.reset());

  it('host: an endpoint opens a room socket, frames go both ways, X closes it', async () => {
    const host = new LocalHost(echoCore, { codes: { alphabet: 'ABCD', length: 4 } });
    const code = host.createRoom('pid-1');
    const bt = await startNearbyHost(host, { game: 'kudominoes', name: 'Ana' });
    await bt.advertise(code);
    expect(fake.calls.find((c) => c.m === 'nearbyAdvertise')!.o).toEqual({ game: 'kudominoes', name: 'Ana', code });

    fake.fire('nearbyOpen', { id: 'e1', incoming: true });
    fake.fire('nearbyData', { id: 'e1', data: `O${JSON.stringify({ code, pid: 'pid-2' })}` });
    fake.fire('nearbyData', { id: 'e1', data: 'F{"t":"hi"}' });
    expect(sent('e1')).toEqual(['F{"echo":{"t":"hi"}}']);
    // a long reply is chunked
    fake.fire('nearbyData', { id: 'e1', data: `F${JSON.stringify({ t: 'x'.repeat(9000) })}` });
    expect(sent('e1').slice(1).map((m) => m[0])).toEqual(['P', 'F']);
    // unknown room: room_not_found frame then X4004
    fake.fire('nearbyData', { id: 'e2', data: `O${JSON.stringify({ code: 'DDDD', pid: null })}` });
    expect(sent('e2')).toEqual(['F{"t":"error","code":"room_not_found"}', 'X4004']);
    await bt.stop();
    expect(fake.calls.some((c) => c.m === 'nearbyStop')).toBe(true);
  });

  it('joiner: connects to the endpoint, opens with O, receives frames, closes on X', async () => {
    const be = nearbyBackend('kudominoes', { id: 'h1', code: 'QWER', name: 'Ana' }, 'Beto');
    expect(await be.roomInfo('QWER')).toEqual({ exists: true });
    await expect(be.createRoom('x')).rejects.toBeTruthy();
    // the host was seen by discovery (lastSeen): no extra search
    const stop = discoverNearby('kudominoes', () => {});
    await tick();
    fake.fire('nearbyFound', { id: 'h1', name: 'QWER|Ana' });
    stop();

    const conn = be.connect('QWER', 'pid-9');
    const got: string[] = [];
    let opened = false;
    let closed = 0;
    conn.onopen = () => (opened = true);
    conn.onmessage = (d) => got.push(d);
    conn.onclose = (c) => (closed = c);
    await tick();
    await tick();
    expect(fake.calls.find((c) => c.m === 'nearbyConnect')!.o).toEqual({ id: 'h1', name: 'Beto' });
    fake.fire('nearbyOpen', { id: 'h1', incoming: false });
    expect(opened).toBe(true);
    expect(sent('h1')[0]).toBe(`O${JSON.stringify({ code: 'QWER', pid: 'pid-9' })}`);
    conn.send('{"t":"hello"}');
    expect(sent('h1')[1]).toBe('F{"t":"hello"}');
    fake.fire('nearbyData', { id: 'h1', data: 'P{"t":"wel' });
    fake.fire('nearbyData', { id: 'h1', data: 'Fcome"}' });
    expect(got).toEqual(['{"t":"welcome"}']);
    fake.fire('nearbyData', { id: 'h1', data: 'X4001' });
    expect(closed).toBe(4001);
  });

  it('a dropped endpoint closes the joiner with 1006', async () => {
    const stop = discoverNearby('kudominoes', () => {});
    await tick();
    fake.fire('nearbyFound', { id: 'h2', name: 'ZZZZ|Ana' });
    stop();
    const conn = nearbyBackend('kudominoes', { id: 'h2', code: 'ZZZZ', name: 'Ana' }, 'Beto').connect('ZZZZ', 'pid-9');
    let closed = 0;
    conn.onclose = (c) => (closed = c);
    await tick();
    await tick();
    fake.fire('nearbyOpen', { id: 'h2', incoming: false });
    fake.fire('nearbyClose', { id: 'h2' });
    expect(closed).toBe(1006);
  });

  it('permission: reports, and asks only when requested', async () => {
    fake.deny();
    expect(await nearbyPermission(false)).toBe(false);
    expect(await nearbyPermission(true)).toBe(true);
    expect(fake.calls.filter((c) => c.m === 'nearbyPermission').map((c) => c.o.request)).toEqual([false, true]);
  });
});
