/**
 * The shapes kunet works with. Frames are JSON strings both ways; kunet never looks inside them, so the
 * same plumbing serves every Ku game (each game keeps its own protocol and room logic).
 */

/** the client end of a connection: the small part of a WebSocket the game client uses */
export interface Conn {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((data: string) => void) | null;
  onclose: ((code: number) => void) | null;
}

/** what a game client needs from wherever its rooms live (the Worker, a local host, the dev mock) */
export interface Backend {
  /** the creator becomes the host */
  createRoom(playerId: string): Promise<string>;
  roomInfo(code: string): Promise<RoomInfo>;
  connect(code: string, playerId: string): Conn;
}

/** GET /api/rooms/:code (each game's RoomInfoResponse has this shape) */
export interface RoomInfo {
  exists: boolean;
  phase?: string;
  freeSeats?: number;
}

/** one joiner's connection, as the host sees it */
export interface Link {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onmessage: ((data: string) => void) | null;
  onclose: (() => void) | null;
}

/** per-socket identity the room core keeps */
export interface Attachment {
  pid: string | null;
  hello: boolean;
}

/** what a game's RoomCore needs from its host platform (the game's own CoreIO<S> is this shape) */
export interface CoreIO<S> {
  now(): number;
  /** a uniform random number in [0, 1) (KuCards' core uses it; others may ignore it) */
  random(): number;
  seed(): number;
  sockets(): S[];
  attachment(s: S): Attachment | null;
  setAttachment(s: S, a: Attachment): void;
  send(s: S, msg: unknown): void;
  close(s: S, code: number, reason: string): void;
}

/** the part of a game's RoomCore kunet drives */
export interface RoomCoreLike<S> {
  data: unknown;
  create(code: string, host: string | null): boolean;
  info(): RoomInfo;
  accept(s: S, pid: string | null): void;
  message(s: S, raw: unknown): void;
  socketGone(s: S): void;
  alarm(): 'deleted' | void;
  nextAlarm(): number | null;
}

/** builds the game's room core over kunet's platform (`data` = a saved room to resume, else null) */
export type MakeCore = <S>(io: CoreIO<S>, data: unknown) => RoomCoreLike<S>;

/** room code rules (each game has its own alphabet / length / display prefix) */
export interface CodeRules {
  alphabet: string;
  length: number;
}
