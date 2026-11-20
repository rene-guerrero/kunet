/**
 * The rooms one device hosts, reachable through any number of transports at once: the device's own
 * player (loopback), Wi-Fi joiners (a WebSocket server: Android plugin or the Node dev host), later
 * Nearby. Every transport ends in the same three calls, which mirror the Worker's routes:
 *   POST /api/rooms          → createRoom(pid)
 *   GET  /api/rooms/:code    → roomInfo(code)
 *   GET  /api/rooms/:code/ws → connect(code, pid, link)
 */
import { LocalRoom, type LocalRoomOptions } from './localRoom';
import type { CodeRules, Link, MakeCore, RoomInfo } from './types';

export interface LocalHostOptions {
  codes: CodeRules;
  /** at most this many rooms at once (a family host needs one; the dev host may want a few) */
  maxRooms?: number;
  /** clock for every room (dev mock skew) */
  now?: () => number;
  /** a room changed (save it) or is gone (data null) */
  onRoomChange?: (code: string, data: unknown | null) => void;
}

export class LocalHostError extends Error {
  constructor(readonly code: 'room_limit' | 'no_free_code') {
    super(code);
  }
}

/** the frame every Ku game's server sends for an unknown room before closing with 4004 */
const ROOM_NOT_FOUND = JSON.stringify({ t: 'error', code: 'room_not_found' });

export class LocalHost {
  private rooms = new Map<string, LocalRoom>();

  constructor(
    private makeCore: MakeCore,
    private opts: LocalHostOptions,
  ) {}

  get codes(): string[] {
    return [...this.rooms.keys()];
  }

  room(code: string): LocalRoom | null {
    return this.rooms.get(code) ?? null;
  }

  private randomCode(): string {
    const { alphabet, length } = this.opts.codes;
    let s = '';
    for (let i = 0; i < length; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
    return s;
  }

  private roomOpts(code: string, extra: LocalRoomOptions = {}): LocalRoomOptions {
    return {
      now: this.opts.now,
      ...extra,
      onChange: (d) => this.opts.onRoomChange?.(code, d),
      onGone: () => {
        this.rooms.delete(code);
        this.opts.onRoomChange?.(code, null);
      },
    };
  }

  createRoom(pid: string | null): string {
    if (this.rooms.size >= (this.opts.maxRooms ?? 8)) throw new LocalHostError('room_limit');
    for (let i = 0; i < 50; i++) {
      const code = this.randomCode();
      if (this.rooms.has(code)) continue;
      this.rooms.set(code, new LocalRoom(code, pid, this.makeCore, this.roomOpts(code)));
      return code;
    }
    throw new LocalHostError('no_free_code');
  }

  /** bring back a saved room (RoomCore.data) under its code, e.g. after the host app restarted */
  resumeRoom(code: string, data: unknown): void {
    this.rooms.get(code)?.stop();
    this.rooms.set(code, new LocalRoom(code, null, this.makeCore, this.roomOpts(code, { resume: data })));
  }

  roomInfo(code: string): RoomInfo {
    return this.rooms.get(code)?.info() ?? { exists: false };
  }

  connect(code: string, pid: string | null, link: Link): void {
    const room = this.rooms.get(code);
    if (room) return room.attach(link, pid);
    try {
      link.send(ROOM_NOT_FOUND);
      link.close(4004, 'room_not_found');
    } catch {
      /* already closed */
    }
  }

  /** run due timers of every room now (the host app returned to the foreground) */
  wake(): void {
    for (const r of [...this.rooms.values()]) r.wake();
  }

  closeRoom(code: string): void {
    const r = this.rooms.get(code);
    if (!r) return;
    r.stop();
    this.rooms.delete(code);
    this.opts.onRoomChange?.(code, null);
  }

  stop(): void {
    for (const code of [...this.rooms.keys()]) this.closeRoom(code);
  }
}
