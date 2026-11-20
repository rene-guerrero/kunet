import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalHost, loopbackBackend, type CoreIO, type MakeCore, type RoomCoreLike } from '../src';
import { serveLan } from '../node/lan.mjs';

/**
 * A tiny room with the RoomCore surface: hello → welcome, 'say' is broadcast, one timer per room
 * ('tick' 1 s after the last message), idle deletion when nobody is left.
 */
interface Data {
  code: string;
  host: string;
  said: string[];
  tickAt: number | null;
  idleAt: number | null;
}
const fakeCore: MakeCore = <S,>(io: CoreIO<S>, resume: unknown): RoomCoreLike<S> => {
  const core = {
    data: (resume as Data | null) ?? null,
    create(code: string, host: string | null) {
      if (core.data) return false;
      core.data = { code, host: host ?? '', said: [], tickAt: null, idleAt: io.now() + 5000 };
      return true;
    },
    info: () => (core.data ? { exists: true as const, phase: 'lobby', freeSeats: 3 } : { exists: false as const }),
    accept(s: S, pid: string | null) {
      io.setAttachment(s, { pid, hello: false });
      if (!core.data) {
        io.send(s, { t: 'error', code: 'room_not_found' });
        io.close(s, 4004, 'room_not_found');
      }
    },
    message(s: S, raw: unknown) {
      const m = JSON.parse(String(raw));
      const d = core.data!;
      if (m.t === 'hello') {
        io.setAttachment(s, { pid: m.playerId, hello: true });
        d.idleAt = null;
        io.send(s, { t: 'welcome', host: d.host === m.playerId });
      } else if (m.t === 'say') {
        d.said.push(m.text);
        d.tickAt = io.now() + 1000;
        for (const x of io.sockets()) io.send(x, { t: 'said', text: m.text });
      }
    },
    socketGone() {
      if (io.sockets().length === 0) core.data!.idleAt = io.now() + 5000;
    },
    alarm() {
      const d = core.data;
      if (!d) return;
      const now = io.now();
      if (d.idleAt !== null && now >= d.idleAt) {
        core.data = null;
        return 'deleted' as const;
      }
      if (d.tickAt !== null && now >= d.tickAt) {
        d.tickAt = null;
        for (const x of io.sockets()) io.send(x, { t: 'tick' });
      }
    },
    nextAlarm: () => {
      const d = core.data;
      if (!d) return null;
      const t = [d.tickAt, d.idleAt].filter((x): x is number => x !== null);
      return t.length ? Math.min(...t) : null;
    },
  };
  return core;
};

const CODES = { alphabet: 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', length: 4 };

describe('LocalHost + loopback', () => {
  afterEach(() => vi.useRealTimers());

  it('creates a room, connects, relays frames and fires the room timer', async () => {
    vi.useFakeTimers();
    const changes: [string, unknown][] = [];
    const host = new LocalHost(fakeCore, { codes: CODES, onRoomChange: (c, d) => changes.push([c, d]) });
    const be = loopbackBackend(host);
    const code = await be.createRoom('pid-1');
    expect(code).toMatch(/^[A-Z2-9]{4}$/);
    expect(await be.roomInfo(code)).toEqual({ exists: true, phase: 'lobby', freeSeats: 3 });
    expect(await be.roomInfo('ZZZZ')).toEqual({ exists: false });

    const got: unknown[] = [];
    const conn = be.connect(code, 'pid-1');
    conn.onmessage = (d) => got.push(JSON.parse(d));
    conn.onopen = () => conn.send(JSON.stringify({ t: 'hello', playerId: 'pid-1' }));
    await vi.advanceTimersByTimeAsync(5);
    expect(got).toEqual([{ t: 'welcome', host: true }]);
    conn.send(JSON.stringify({ t: 'say', text: 'hola' }));
    await vi.advanceTimersByTimeAsync(5);
    expect(got.at(-1)).toEqual({ t: 'said', text: 'hola' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(got.at(-1)).toEqual({ t: 'tick' });
    expect(changes.some(([c, d]) => c === code && (d as Data).said.includes('hola'))).toBe(true);

    // everyone leaves: the idle timer deletes the room
    let closed = -1;
    conn.onclose = (c) => (closed = c);
    conn.close(1000);
    await vi.advanceTimersByTimeAsync(5);
    expect(closed).toBe(1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(host.roomInfo(code)).toEqual({ exists: false });
    expect(changes.at(-1)).toEqual([code, null]);
  });

  it('an unknown room answers room_not_found and closes with 4004', async () => {
    vi.useFakeTimers();
    const host = new LocalHost(fakeCore, { codes: CODES });
    const conn = loopbackBackend(host).connect('ABCD', 'pid-1');
    const got: string[] = [];
    let code = 0;
    conn.onmessage = (d) => got.push(d);
    conn.onclose = (c) => (code = c);
    await vi.advanceTimersByTimeAsync(5);
    expect(got).toEqual([JSON.stringify({ t: 'error', code: 'room_not_found' })]);
    expect(code).toBe(4004);
  });

  it('resumes a saved room under its code', async () => {
    vi.useFakeTimers();
    let saved: unknown = null;
    const a = new LocalHost(fakeCore, { codes: CODES, onRoomChange: (_c, d) => (saved = d) });
    const code = a.createRoom('pid-1');
    a.stop();
    const b = new LocalHost(fakeCore, { codes: CODES });
    b.resumeRoom(code, JSON.parse(JSON.stringify(saved)));
    expect(b.roomInfo(code).exists).toBe(true);
  });

  it('honours the room limit', () => {
    const host = new LocalHost(fakeCore, { codes: CODES, maxRooms: 1 });
    host.createRoom(null);
    expect(() => host.createRoom(null)).toThrow('room_limit');
  });
});

describe('serveLan (Node dev host)', () => {
  it('serves the game with the local flag, the room routes and the WebSocket', async () => {
    const root = mkdtempSync(join(tmpdir(), 'kunet-'));
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><head><title>t</title></head><body></body></html>');
    writeFileSync(join(root, 'app.js'), 'console.log(1)');
    const host = new LocalHost(fakeCore, { codes: CODES });
    const lan = await serveLan({ root, game: 'testgame', host, port: 18787, bind: '127.0.0.1', log: () => {} });
    try {
      const base = `http://127.0.0.1:${lan.port}`;
      const page = await (await fetch(`${base}/?sala=ABCD`)).text();
      expect(page).toContain('window.__KUNET_LOCAL__={"game":"testgame","kind":"node","name":""}');
      const js = await fetch(`${base}/app.js`);
      expect(js.headers.get('content-type')).toContain('javascript');
      expect((await fetch(`${base}/%2e%2e%2f%2e%2e%2fsecret.txt`)).status).not.toBe(200);
      expect((await fetch(`${base}/sw.js`)).status).toBe(404);

      const { code } = await (await fetch(`${base}/api/rooms?pid=pid-1`, { method: 'POST' })).json();
      expect(await (await fetch(`${base}/api/rooms/${code}`)).json()).toEqual({ exists: true, phase: 'lobby', freeSeats: 3 });
      expect(await (await fetch(`${base}/api/rooms/QQQQ`)).json()).toEqual({ exists: false });

      const ws = new WebSocket(`ws://127.0.0.1:${lan.port}/api/rooms/${code}/ws?pid=pid-1`);
      const msgs: unknown[] = [];
      await new Promise<void>((ok, fail) => {
        ws.onerror = () => fail(new Error('ws error'));
        ws.onopen = () => ws.send(JSON.stringify({ t: 'hello', playerId: 'pid-1' }));
        ws.onmessage = (e) => {
          msgs.push(JSON.parse(String(e.data)));
          if (msgs.length === 1) ws.send(JSON.stringify({ t: 'say', text: 'hola' }));
          if (msgs.length === 2) ok();
        };
      });
      expect(msgs).toEqual([{ t: 'welcome', host: true }, { t: 'said', text: 'hola' }]);
      ws.close();
    } finally {
      await lan.close();
    }
  });
});
