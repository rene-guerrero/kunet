/**
 * The hosting device's own player: a Backend whose connections are in-memory pairs (Conn on the client
 * side, Link on the host side) into a LocalHost in the same page. Messages are delivered asynchronously
 * (a macrotask, plus optional latency) and in order — frames sent before a close still arrive, then the
 * close — like a real socket, so the client code cannot tell the difference.
 */
import type { LocalHost } from './localHost';
import type { Backend, Conn, Link } from './types';

export interface Pair {
  conn: Conn;
  link: Link;
}

/** an in-memory socket pair; `open()` fires the client's onopen */
export function linkPair(latencyMs = 0): Pair & { open(): void } {
  let closed = false;
  const later = (f: () => void) => setTimeout(f, latencyMs);
  const conn: Conn = {
    send: (d) => {
      if (!closed) later(() => link.onmessage?.(d));
    },
    close: (code = 1000) => {
      if (closed) return;
      closed = true;
      later(() => {
        link.onclose?.();
        conn.onclose?.(code);
      });
    },
    onopen: null,
    onmessage: null,
    onclose: null,
  };
  const link: Link = {
    send: (d) => {
      if (!closed) later(() => conn.onmessage?.(d));
    },
    close: (code = 1000) => {
      if (closed) return;
      closed = true;
      later(() => {
        link.onclose?.();
        conn.onclose?.(code);
      });
    },
    onmessage: null,
    onclose: null,
  };
  return { conn, link, open: () => later(() => !closed && conn.onopen?.()) };
}

export function loopbackBackend(host: LocalHost, latencyMs = 0): Backend {
  return {
    createRoom: async (pid) => host.createRoom(pid),
    roomInfo: async (code) => host.roomInfo(code),
    connect: (code, pid) => {
      const p = linkPair(latencyMs);
      // the host side attaches first (it may answer room_not_found and close at once)
      setTimeout(() => {
        host.connect(code, pid, p.link);
        p.open();
      }, latencyMs);
      return p.conn;
    },
  };
}
