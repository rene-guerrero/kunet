package com.kunet.local;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * The app joining another device's room. Its WebView page is https://localhost, so a plain
 * `ws://192.168.x.x` or `fetch('http://…')` from JavaScript is blocked as mixed content; these raw-socket
 * clients run natively instead (also outside Android's cleartext policy, which only governs the platform
 * HTTP stacks). Free of Android APIs, tested on a desktop JVM.
 */
public final class LanClient {
  private LanClient() {}

  public static final class HttpResult {
    public final int status;
    public final String body;

    HttpResult(int status, String body) {
      this.status = status;
      this.body = body;
    }
  }

  /** one HTTP/1.1 request (Connection: close) to an http:// URL; small JSON bodies only */
  public static HttpResult request(String method, String url, int timeoutMs) throws IOException {
    URI u = URI.create(url);
    if (!"http".equals(u.getScheme())) throw new IOException("http only");
    int port = u.getPort() < 0 ? 80 : u.getPort();
    String target = (u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath()) + (u.getRawQuery() == null ? "" : "?" + u.getRawQuery());
    try (Socket s = new Socket()) {
      s.connect(new InetSocketAddress(u.getHost(), port), timeoutMs);
      s.setSoTimeout(timeoutMs);
      OutputStream out = s.getOutputStream();
      String req = method + " " + target + " HTTP/1.1\r\nHost: " + u.getHost() + ":" + port + "\r\nConnection: close\r\nContent-Length: 0\r\nAccept: application/json\r\n\r\n";
      out.write(req.getBytes(StandardCharsets.ISO_8859_1));
      out.flush();
      InputStream in = new BufferedInputStream(s.getInputStream());
      Map<String, String> h = new HashMap<>();
      int status = readHead(in, h);
      byte[] body;
      if ("chunked".equalsIgnoreCase(h.getOrDefault("transfer-encoding", ""))) body = readChunked(in);
      else if (h.containsKey("content-length")) {
        body = new byte[Integer.parseInt(h.get("content-length").trim())];
        LanServer.readFully(in, body);
      } else body = readAll(in);
      return new HttpResult(status, new String(body, StandardCharsets.UTF_8));
    }
  }

  private static int readHead(InputStream in, Map<String, String> headers) throws IOException {
    ByteArrayOutputStream buf = new ByteArrayOutputStream();
    int state = 0;
    while (state < 4) {
      int b = in.read();
      if (b < 0) throw new IOException("eof in headers");
      buf.write(b);
      if (buf.size() > 16 * 1024) throw new IOException("headers too large");
      if (b == '\r' && (state == 0 || state == 2)) state++;
      else if (b == '\n' && (state == 1 || state == 3)) state++;
      else state = b == '\r' ? 1 : 0;
    }
    String[] lines = buf.toString("ISO-8859-1").split("\r\n");
    String[] first = lines[0].split(" ");
    for (int i = 1; i < lines.length; i++) {
      int c = lines[i].indexOf(':');
      if (c > 0) headers.put(lines[i].substring(0, c).trim().toLowerCase(Locale.ROOT), lines[i].substring(c + 1).trim());
    }
    return Integer.parseInt(first[1]);
  }

  private static byte[] readChunked(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    while (true) {
      StringBuilder line = new StringBuilder();
      int b;
      while ((b = in.read()) >= 0 && b != '\n') if (b != '\r') line.append((char) b);
      int semi = line.indexOf(";");
      int n = Integer.parseInt((semi < 0 ? line.toString() : line.substring(0, semi)).trim(), 16);
      if (n == 0) return out.toByteArray();
      byte[] chunk = new byte[n];
      LanServer.readFully(in, chunk);
      out.write(chunk);
      in.read();
      in.read(); // CRLF
    }
  }

  private static byte[] readAll(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] b = new byte[4096];
    int k;
    while ((k = in.read(b)) > 0) out.write(b, 0, k);
    return out.toByteArray();
  }

  // ───────────────────────── WebSocket client ─────────────────────────

  public interface WsListener {
    void onOpen();

    void onMessage(String data);

    /** always called once at the end (1006 = dropped without a close frame) */
    void onClose(int code);
  }

  public static final class Ws {
    private final Socket socket = new Socket();
    private OutputStream out;
    private final WsListener listener;
    private volatile boolean closed;
    private boolean closeReported;
    private final SecureRandom rnd = new SecureRandom();

    private Ws(WsListener l) {
      this.listener = l;
    }

    /** connects on a background thread; the listener hears onOpen or onClose(1006) */
    public static Ws connect(final String url, final int timeoutMs, WsListener l) {
      final Ws ws = new Ws(l);
      Thread t = new Thread(() -> ws.run(url, timeoutMs), "kunet-ws-client");
      t.setDaemon(true);
      t.start();
      return ws;
    }

    private void run(String url, int timeoutMs) {
      int code = 1006;
      try {
        URI u = URI.create(url);
        if (!"ws".equals(u.getScheme())) throw new IOException("ws only");
        int port = u.getPort() < 0 ? 80 : u.getPort();
        String target = (u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath()) + (u.getRawQuery() == null ? "" : "?" + u.getRawQuery());
        socket.connect(new InetSocketAddress(u.getHost(), port), timeoutMs);
        socket.setTcpNoDelay(true);
        socket.setSoTimeout(timeoutMs);
        out = socket.getOutputStream();
        byte[] k = new byte[16];
        rnd.nextBytes(k);
        String key = LanServer.b64(k);
        String req = "GET " + target + " HTTP/1.1\r\nHost: " + u.getHost() + ":" + port + "\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: " + key + "\r\nSec-WebSocket-Version: 13\r\n\r\n";
        synchronized (this) {
          out.write(req.getBytes(StandardCharsets.ISO_8859_1));
          out.flush();
        }
        InputStream in = new BufferedInputStream(socket.getInputStream());
        Map<String, String> h = new HashMap<>();
        int status = readHead(in, h);
        if (status != 101) throw new IOException("upgrade refused: " + status);
        socket.setSoTimeout(0);
        if (closed) return;
        listener.onOpen();
        code = readLoop(in);
      } catch (IOException | RuntimeException e) {
        code = 1006;
      } finally {
        try {
          socket.close();
        } catch (IOException ignored) {
        }
        closed = true;
        report(code);
      }
    }

    private synchronized void report(int code) {
      if (closeReported) return;
      closeReported = true;
      listener.onClose(code);
    }

    private int readLoop(InputStream in) throws IOException {
      ByteArrayOutputStream msg = null;
      while (true) {
        int b0 = in.read();
        int b1 = in.read();
        if (b0 < 0 || b1 < 0) return 1006;
        boolean fin = (b0 & 0x80) != 0;
        int op = b0 & 0x0f;
        long len = b1 & 0x7f;
        if (len == 126) len = (LanServer.readByte(in) << 8) | LanServer.readByte(in);
        else if (len == 127) {
          len = 0;
          for (int i = 0; i < 8; i++) len = (len << 8) | LanServer.readByte(in);
        }
        if (len > 1 << 20) return 1009;
        byte[] p = new byte[(int) len];
        LanServer.readFully(in, p);
        switch (op) {
          case 0x0:
            if (msg == null) break;
            msg.write(p);
            if (fin) {
              listener.onMessage(msg.toString("UTF-8"));
              msg = null;
            }
            break;
          case 0x1:
            if (fin) listener.onMessage(new String(p, StandardCharsets.UTF_8));
            else {
              msg = new ByteArrayOutputStream();
              msg.write(p);
            }
            break;
          case 0x8: {
            int code = p.length >= 2 ? ((p[0] & 0xff) << 8) | (p[1] & 0xff) : 1005;
            if (!closed) {
              try {
                frame(0x8, p.length >= 2 ? new byte[] {p[0], p[1]} : new byte[0]);
              } catch (IOException ignored) {
              }
            }
            return code;
          }
          case 0x9:
            frame(0xA, p);
            break;
          default:
            break;
        }
      }
    }

    /** client frames are masked (RFC 6455) */
    private synchronized void frame(int op, byte[] payload) throws IOException {
      if (out == null) throw new IOException("not open");
      int n = payload.length;
      ByteArrayOutputStream f = new ByteArrayOutputStream(n + 14);
      f.write(0x80 | op);
      if (n < 126) f.write(0x80 | n);
      else if (n < 65536) {
        f.write(0x80 | 126);
        f.write(n >>> 8);
        f.write(n & 0xff);
      } else {
        f.write(0x80 | 127);
        for (int i = 7; i >= 0; i--) f.write((int) (((long) n >>> (8 * i)) & 0xff));
      }
      byte[] mask = new byte[4];
      rnd.nextBytes(mask);
      f.write(mask);
      for (int i = 0; i < n; i++) f.write(payload[i] ^ mask[i & 3]);
      out.write(f.toByteArray());
      out.flush();
    }

    public void send(String data) {
      if (closed) return;
      try {
        frame(0x1, data.getBytes(StandardCharsets.UTF_8));
      } catch (IOException e) {
        close(1006, "");
      }
    }

    public void close(int code, String reason) {
      if (closed) return;
      closed = true;
      try {
        byte[] r = (reason == null ? "" : reason).getBytes(StandardCharsets.UTF_8);
        byte[] p = new byte[2 + Math.min(r.length, 120)];
        p[0] = (byte) (code >>> 8);
        p[1] = (byte) (code & 0xff);
        System.arraycopy(r, 0, p, 2, p.length - 2);
        frame(0x8, p);
      } catch (IOException ignored) {
      }
      try {
        socket.close();
      } catch (IOException ignored) {
      }
      report(code);
    }
  }
}
