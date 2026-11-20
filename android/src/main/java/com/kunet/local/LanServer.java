package com.kunet.local;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketException;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * A small HTTP/1.1 + WebSocket server on one port, free of Android APIs (so it is tested on a desktop
 * JVM). It serves a game's web build and the same room routes as the Worker:
 *
 *   GET  /...                      static files (index.html gets the host's script injected)
 *   POST /api/rooms?pid=           answered by the Handler (JavaScript decides)
 *   GET  /api/rooms/:code          answered by the Handler
 *   GET  /api/rooms/:code/ws?pid=  WebSocket: text frames go to / come from the Handler as "links"
 *
 * One thread per connection; frames to one socket are written under its lock. Plain cleartext on the
 * local network: page and socket share one http:// origin, so browsers join without mixed content.
 */
public final class LanServer {

  /** what the server needs from its host (the Capacitor plugin, or a test) */
  public interface Handler {
    /** a file of the web build ("index.html", "assets/x.js"); null when missing */
    byte[] readAsset(String path) throws IOException;

    /** inserted right after <head> in index.html (the host's window.__KUNET_LOCAL__) */
    String headInject();

    /** an /api request; complete the future with the response (JSON body) */
    void onApi(String method, String path, Map<String, String> query, CompletableFuture<ApiResponse> res);

    void onLinkOpen(int id, String code, String pid);

    void onLinkMessage(int id, String data);

    void onLinkClose(int id);
  }

  public static final class ApiResponse {
    public final int status;
    public final String json;

    public ApiResponse(int status, String json) {
      this.status = status;
      this.json = json;
    }
  }

  private static final String WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
  private static final int MAX_HEADER = 16 * 1024;
  private static final int MAX_FRAME = 64 * 1024;
  private static final Map<String, String> TYPES = new HashMap<>();

  static {
    TYPES.put("html", "text/html; charset=utf-8");
    TYPES.put("js", "text/javascript; charset=utf-8");
    TYPES.put("mjs", "text/javascript; charset=utf-8");
    TYPES.put("css", "text/css; charset=utf-8");
    TYPES.put("json", "application/json");
    TYPES.put("webmanifest", "application/manifest+json");
    TYPES.put("svg", "image/svg+xml");
    TYPES.put("png", "image/png");
    TYPES.put("jpg", "image/jpeg");
    TYPES.put("jpeg", "image/jpeg");
    TYPES.put("webp", "image/webp");
    TYPES.put("ico", "image/x-icon");
    TYPES.put("mp3", "audio/mpeg");
    TYPES.put("ogg", "audio/ogg");
    TYPES.put("wav", "audio/wav");
    TYPES.put("woff2", "font/woff2");
    TYPES.put("woff", "font/woff");
    TYPES.put("ttf", "font/ttf");
    TYPES.put("glb", "model/gltf-binary");
    TYPES.put("wasm", "application/wasm");
    TYPES.put("txt", "text/plain; charset=utf-8");
  }

  private final Handler handler;
  private ServerSocket server;
  private Thread acceptThread;
  private volatile boolean running;
  private final AtomicInteger nextId = new AtomicInteger(1);
  private final Map<Integer, WsConn> links = new ConcurrentHashMap<>();

  public LanServer(Handler handler) {
    this.handler = handler;
  }

  /** listen on `port`, or the next free one (up to 20 further); returns the port in use */
  public synchronized int start(int port) throws IOException {
    if (running) return server.getLocalPort();
    IOException last = null;
    for (int p = port; p <= port + 20; p++) {
      try {
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(p));
        server = s;
        last = null;
        break;
      } catch (IOException e) {
        last = e;
      }
    }
    if (last != null) throw last;
    running = true;
    acceptThread = new Thread(this::acceptLoop, "kunet-lan-accept");
    acceptThread.setDaemon(true);
    acceptThread.start();
    return server.getLocalPort();
  }

  public int port() {
    return server == null ? -1 : server.getLocalPort();
  }

  public boolean isRunning() {
    return running;
  }

  public synchronized void stop() {
    running = false;
    try {
      if (server != null) server.close();
    } catch (IOException ignored) {
    }
    for (WsConn c : links.values()) c.close(1001, "host_closed");
    links.clear();
  }

  /** a text frame to one link (no-op when it is gone) */
  public void send(int id, String data) {
    WsConn c = links.get(id);
    if (c != null) c.sendText(data);
  }

  public void close(int id, int code, String reason) {
    WsConn c = links.get(id);
    if (c != null) c.close(code, reason);
  }

  // ───────────────────────── HTTP ─────────────────────────

  private void acceptLoop() {
    while (running) {
      try {
        final Socket s = server.accept();
        Thread t = new Thread(() -> serve(s), "kunet-lan-conn");
        t.setDaemon(true);
        t.start();
      } catch (IOException e) {
        if (!running) return;
      }
    }
  }

  private static final class Request {
    String method;
    String target;
    String path;
    Map<String, String> query = new HashMap<>();
    Map<String, String> headers = new HashMap<>();
  }

  private void serve(Socket s) {
    try {
      s.setTcpNoDelay(true);
      s.setSoTimeout(20_000);
      InputStream in = new BufferedInputStream(s.getInputStream());
      OutputStream out = s.getOutputStream();
      while (running) {
        Request req = readRequest(in);
        if (req == null) break;
        // discard a request body (our routes take none)
        String cl = req.headers.get("content-length");
        if (cl != null) {
          long n = Long.parseLong(cl.trim());
          while (n > 0) {
            long k = in.skip(n);
            if (k <= 0) {
              if (in.read() < 0) break;
              k = 1;
            }
            n -= k;
          }
        }
        if ("websocket".equalsIgnoreCase(req.headers.getOrDefault("upgrade", ""))) {
          upgrade(s, in, out, req);
          return; // the socket now belongs to the WebSocket
        }
        boolean keep = !"close".equalsIgnoreCase(req.headers.getOrDefault("connection", ""));
        route(req, out);
        out.flush();
        if (!keep) break;
      }
    } catch (IOException | RuntimeException ignored) {
      // client went away / bad request
    }
    try {
      s.close();
    } catch (IOException ignored) {
    }
  }

  private static Request readRequest(InputStream in) throws IOException {
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    int state = 0;
    while (state < 4) {
      int b = in.read();
      if (b < 0) return null;
      buf.write(b);
      if (buf.size() > MAX_HEADER) throw new IOException("header too large");
      if (b == '\r' && (state == 0 || state == 2)) state++;
      else if (b == '\n' && (state == 1 || state == 3)) state++;
      else state = b == '\r' ? 1 : 0;
    }
    String[] lines = buf.toString("ISO-8859-1").split("\r\n");
    String[] first = lines[0].split(" ");
    if (first.length < 3) throw new IOException("bad request line");
    Request r = new Request();
    r.method = first[0].toUpperCase(Locale.ROOT);
    r.target = first[1];
    int q = r.target.indexOf('?');
    r.path = q < 0 ? r.target : r.target.substring(0, q);
    if (q >= 0) {
      for (String kv : r.target.substring(q + 1).split("&")) {
        if (kv.isEmpty()) continue;
        int e = kv.indexOf('=');
        String k = e < 0 ? kv : kv.substring(0, e);
        String v = e < 0 ? "" : kv.substring(e + 1);
        r.query.put(dec(k), dec(v));
      }
    }
    for (int i = 1; i < lines.length; i++) {
      int c = lines[i].indexOf(':');
      if (c > 0) r.headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
    }
    return r;
  }

  private static String dec(String s) {
    try {
      return URLDecoder.decode(s, "UTF-8");
    } catch (Exception e) {
      return s;
    }
  }

  private void route(Request req, OutputStream out) throws IOException {
    if (req.path.equals("/api") || req.path.startsWith("/api/")) {
      CompletableFuture<ApiResponse> f = new CompletableFuture<>();
      ApiResponse r;
      try {
        handler.onApi(req.method, req.path, req.query, f);
        r = f.get(8, TimeUnit.SECONDS);
      } catch (Exception e) {
        r = new ApiResponse(500, "{\"error\":\"internal\"}");
      }
      byte[] body = r.json.getBytes(StandardCharsets.UTF_8);
      head(out, r.status, "application/json", body.length, "no-store");
      out.write(body);
      return;
    }
    if (!req.method.equals("GET") && !req.method.equals("HEAD")) {
      text(out, 405, "method");
      return;
    }
    String rel = dec(req.path);
    while (rel.startsWith("/")) rel = rel.substring(1);
    if (rel.isEmpty()) rel = "index.html";
    // no way out of the web build
    for (String part : rel.split("[/\\\\]")) {
      if (part.equals("..")) {
        text(out, 403, "forbidden");
        return;
      }
    }
    if (rel.endsWith("/")) rel += "index.html";
    if (rel.equals("sw.js") || rel.endsWith("/sw.js")) {
      text(out, 404, "not found"); // the web build's offline cache is not used on a LAN origin
      return;
    }
    byte[] data = handler.readAsset(rel);
    if (data == null) {
      if (ext(rel).isEmpty()) {
        rel = "index.html"; // ?sala= links and app routes get the app
        data = handler.readAsset(rel);
      }
      if (data == null) {
        text(out, 404, "not found");
        return;
      }
    }
    boolean html = rel.equals("index.html");
    if (html) {
      String page = new String(data, StandardCharsets.UTF_8).replaceFirst("<head>", "<head>" + java.util.regex.Matcher.quoteReplacement(handler.headInject()));
      data = page.getBytes(StandardCharsets.UTF_8);
    }
    String type = TYPES.getOrDefault(ext(rel), "application/octet-stream");
    String cache = html ? "no-store" : rel.startsWith("assets/") ? "public, max-age=31536000, immutable" : "no-cache";
    head(out, 200, type, data.length, cache);
    if (req.method.equals("GET")) out.write(data);
  }

  private static String ext(String path) {
    int slash = path.lastIndexOf('/');
    int dot = path.lastIndexOf('.');
    return dot > slash ? path.substring(dot + 1).toLowerCase(Locale.ROOT) : "";
  }

  private static void head(OutputStream out, int status, String type, int length, String cache) throws IOException {
    String h = "HTTP/1.1 " + status + " " + reason(status) + "\r\n"
        + "Content-Type: " + type + "\r\n"
        + "Content-Length: " + length + "\r\n"
        + "Cache-Control: " + cache + "\r\n"
        + "Connection: keep-alive\r\n\r\n";
    out.write(h.getBytes(StandardCharsets.ISO_8859_1));
  }

  private static void text(OutputStream out, int status, String msg) throws IOException {
    byte[] b = ("{\"error\":\"" + msg + "\"}").getBytes(StandardCharsets.UTF_8);
    head(out, status, "application/json", b.length, "no-store");
    out.write(b);
  }

  private static String reason(int s) {
    switch (s) {
      case 101: return "Switching Protocols";
      case 200: return "OK";
      case 201: return "Created";
      case 400: return "Bad Request";
      case 403: return "Forbidden";
      case 404: return "Not Found";
      case 405: return "Method Not Allowed";
      case 503: return "Service Unavailable";
      default: return s >= 500 ? "Server Error" : "OK";
    }
  }

  // ───────────────────────── WebSocket ─────────────────────────

  private void upgrade(Socket s, InputStream in, OutputStream out, Request req) throws IOException {
    String[] parts = req.path.replaceAll("/+$", "").split("/");
    // "", "api", "rooms", code, "ws"
    String key = req.headers.get("sec-websocket-key");
    if (parts.length != 5 || !parts[1].equals("api") || !parts[2].equals("rooms") || !parts[4].equals("ws") || key == null) {
      text(out, 400, "bad_upgrade");
      s.close();
      return;
    }
    String accept;
    try {
      MessageDigest sha1 = MessageDigest.getInstance("SHA-1");
      accept = b64(sha1.digest((key.trim() + WS_GUID).getBytes(StandardCharsets.ISO_8859_1)));
    } catch (Exception e) {
      throw new IOException(e);
    }
    out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n").getBytes(StandardCharsets.ISO_8859_1));
    out.flush();
    s.setSoTimeout(0); // the room's ping/pong keeps it alive; a dead peer is noticed on write
    int id = nextId.getAndIncrement();
    WsConn c = new WsConn(id, s, out);
    links.put(id, c);
    handler.onLinkOpen(id, dec(parts[3]), req.query.get("pid"));
    try {
      c.readLoop(in);
    } finally {
      c.closeQuietly();
      if (links.remove(id) != null) handler.onLinkClose(id);
    }
  }

  private final class WsConn {
    final int id;
    final Socket socket;
    final OutputStream out;
    volatile boolean closed;

    WsConn(int id, Socket socket, OutputStream out) {
      this.id = id;
      this.socket = socket;
      this.out = out;
    }

    void readLoop(InputStream in) throws IOException {
      ByteArrayOutputStream msg = null;
      while (!closed) {
        int b0 = in.read();
        int b1 = in.read();
        if (b0 < 0 || b1 < 0) return;
        boolean fin = (b0 & 0x80) != 0;
        int op = b0 & 0x0f;
        boolean masked = (b1 & 0x80) != 0;
        long len = b1 & 0x7f;
        if (len == 126) len = (readByte(in) << 8) | readByte(in);
        else if (len == 127) {
          len = 0;
          for (int i = 0; i < 8; i++) len = (len << 8) | readByte(in);
        }
        if (len > MAX_FRAME) {
          close(1009, "too_big");
          return;
        }
        byte[] mask = new byte[4];
        if (masked) readFully(in, mask);
        byte[] payload = new byte[(int) len];
        readFully(in, payload);
        if (masked) for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
        switch (op) {
          case 0x0: // continuation
            if (msg == null) break;
            msg.write(payload);
            if (msg.size() > MAX_FRAME) {
              close(1009, "too_big");
              return;
            }
            if (fin) {
              handler.onLinkMessage(id, msg.toString("UTF-8"));
              msg = null;
            }
            break;
          case 0x1: // text
            if (fin) handler.onLinkMessage(id, new String(payload, StandardCharsets.UTF_8));
            else {
              msg = new ByteArrayOutputStream();
              msg.write(payload);
            }
            break;
          case 0x8: { // close: echo it and stop
            int code = payload.length >= 2 ? ((payload[0] & 0xff) << 8) | (payload[1] & 0xff) : 1000;
            close(code == 1005 || code == 1006 ? 1000 : code, "");
            return;
          }
          case 0x9: // ping
            write(0xA, payload);
            break;
          default: // pong, binary: ignored
            break;
        }
      }
    }

    void sendText(String data) {
      if (closed) return;
      try {
        write(0x1, data.getBytes(StandardCharsets.UTF_8));
      } catch (IOException e) {
        closeQuietly();
      }
    }

    synchronized void write(int op, byte[] payload) throws IOException {
      int n = payload.length;
      ByteArrayOutputStream f = new ByteArrayOutputStream(n + 10);
      f.write(0x80 | op);
      if (n < 126) f.write(n);
      else if (n < 65536) {
        f.write(126);
        f.write(n >>> 8);
        f.write(n & 0xff);
      } else {
        f.write(127);
        for (int i = 7; i >= 0; i--) f.write((int) (((long) n >>> (8 * i)) & 0xff));
      }
      f.write(payload);
      out.write(f.toByteArray());
      out.flush();
    }

    void close(int code, String reason) {
      if (closed) return;
      try {
        byte[] r = (reason == null ? "" : reason).getBytes(StandardCharsets.UTF_8);
        byte[] p = new byte[2 + Math.min(r.length, 120)];
        p[0] = (byte) (code >>> 8);
        p[1] = (byte) (code & 0xff);
        System.arraycopy(r, 0, p, 2, p.length - 2);
        write(0x8, p);
      } catch (IOException ignored) {
      }
      closeQuietly();
    }

    void closeQuietly() {
      closed = true;
      try {
        socket.close();
      } catch (IOException ignored) {
      }
    }
  }

  /** base64 (java.util.Base64 needs Android API 26; the apps support 24) */
  static String b64(byte[] b) {
    final String A = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    StringBuilder sb = new StringBuilder((b.length + 2) / 3 * 4);
    for (int i = 0; i < b.length; i += 3) {
      int n = (b[i] & 0xff) << 16 | (i + 1 < b.length ? (b[i + 1] & 0xff) << 8 : 0) | (i + 2 < b.length ? b[i + 2] & 0xff : 0);
      sb.append(A.charAt(n >>> 18 & 63)).append(A.charAt(n >>> 12 & 63));
      sb.append(i + 1 < b.length ? A.charAt(n >>> 6 & 63) : '=').append(i + 2 < b.length ? A.charAt(n & 63) : '=');
    }
    return sb.toString();
  }

  static int readByte(InputStream in) throws IOException {
    int b = in.read();
    if (b < 0) throw new SocketException("eof");
    return b;
  }

  static void readFully(InputStream in, byte[] b) throws IOException {
    int off = 0;
    while (off < b.length) {
      int k = in.read(b, off, b.length - off);
      if (k < 0) throw new SocketException("eof");
      off += k;
    }
  }
}
