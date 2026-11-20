/**
 * A game's room core hosted in this process (a phone's WebView, a Node script, a browser tab for the dev
 * mock): Links are its sockets and one setTimeout is its alarm, exactly as the Durable Object uses its
 * single storage alarm. The core processes everything that came due when the timer finally fires, so a
 * host that was paused (backgrounded app) catches up on its own.
 */
import type { Attachment, Link, MakeCore, RoomCoreLike, RoomInfo } from './types';

export interface LocalRoomOptions {
  /** the room's clock (dev mock: runs ahead to exercise the clients' clock offset) */
  now?: () => number;
  /** a saved room (RoomCore.data) to resume instead of creating a new one */
  resume?: unknown;
  /** called after every change with the room's data (save it to resume after a restart) */
  onChange?: (data: unknown) => void;
  /** the room is gone (idle clean-up) */
  onGone?: () => void;
}

interface Entry {
  att: Attachment | null;
  open: boolean;
}

const randomSeed = (): number => {
  // (no DOM / Node typings assumed: kunet also compiles inside a Worker's tsconfig)
  const c = (globalThis as { crypto?: { getRandomValues(a: Uint32Array): Uint32Array } }).crypto;
  if (c?.getRandomValues) return c.getRandomValues(new Uint32Array(1))[0] | 0;
  return (Math.random() * 0x7fffffff) | 0;
};

export class LocalRoom {
  private links = new Map<Link, Entry>();
  private core: RoomCoreLike<Link>;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private now: () => number;
  private gone = false;

  constructor(
    readonly code: string,
    host: string | null,
    makeCore: MakeCore,
    private opts: LocalRoomOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.core = makeCore<Link>(
      {
        now: this.now,
        seed: randomSeed,
        sockets: () => [...this.links].filter(([, e]) => e.open).map(([l]) => l),
        attachment: (l) => this.links.get(l)?.att ?? null,
        setAttachment: (l, a) => {
          const e = this.links.get(l);
          if (e) e.att = a;
        },
        send: (l, msg) => {
          if (!this.links.get(l)?.open) return;
          try {
            l.send(JSON.stringify(msg));
          } catch {
            /* link going away */
          }
        },
        close: (l, code, reason) => {
          const e = this.links.get(l);
          if (!e || !e.open) return;
          e.open = false;
          try {
            l.close(code, reason);
          } catch {
            /* already closed */
          }
        },
      },
      opts.resume ?? null,
    );
    if (!opts.resume) this.core.create(code, host);
    this.changed();
  }

  get data(): unknown {
    return this.core.data;
  }

  get alive(): boolean {
    return !this.gone;
  }

  info(): RoomInfo {
    return this.core.info();
  }

  /** a joiner connected (`pid` from the URL, may be null: then their hello decides) */
  attach(link: Link, pid: string | null): void {
    this.links.set(link, { att: null, open: true });
    link.onmessage = (data) => this.receive(link, data);
    link.onclose = () => this.detach(link);
    this.core.accept(link, pid);
    this.changed();
  }

  /** process due timers now (e.g. when the host app comes back to the foreground) */
  wake(): void {
    if (this.gone) return;
    if (this.core.alarm() === 'deleted') return this.die();
    this.changed();
  }

  /** stop the room: every link is closed, the timer cancelled */
  stop(): void {
    for (const [l, e] of this.links) {
      if (!e.open) continue;
      e.open = false;
      try {
        l.close(1001, 'host_closed');
      } catch {
        /* already closed */
      }
    }
    this.links.clear();
    this.disarm();
    this.gone = true;
  }

  private receive(link: Link, data: string): void {
    if (!this.links.get(link)?.open) return;
    this.core.message(link, data);
    this.changed();
  }

  private detach(link: Link): void {
    const e = this.links.get(link);
    if (!e) return;
    e.open = false;
    this.core.socketGone(link);
    this.links.delete(link);
    this.changed();
  }

  private changed(): void {
    if (this.gone) return;
    if (this.core.data) this.opts.onChange?.(this.core.data);
    this.arm();
  }

  private disarm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** the single alarm, like the Durable Object's */
  private arm(): void {
    this.disarm();
    const at = this.core.nextAlarm();
    if (at === null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.wake();
    }, Math.max(1, at - this.now()));
  }

  private die(): void {
    this.stop();
    this.opts.onGone?.();
  }
}
