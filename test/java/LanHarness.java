import com.kunet.local.LanClient;
import com.kunet.local.LanServer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;

/**
 * Desktop check of the Android plugin's server and clients (no Android needed):
 *   java LanHarness <webRoot>   → self-test with LanClient, then prints "READY <port>" and keeps serving
 * for the Node side of the test (fetch + WebSocket, like a browser). Room 'ABCD' exists; a link echoes
 * every frame back as "echo:<data>"; "bye" makes the server close it with 4000.
 */
public class LanHarness {
  static LanServer server;

  public static void main(String[] args) throws Exception {
    final Path root = Path.of(args[0]).toAbsolutePath().normalize();
    server = new LanServer(new LanServer.Handler() {
      public byte[] readAsset(String path) {
        try {
          Path p = root.resolve(path).normalize();
          return p.startsWith(root) && Files.isRegularFile(p) ? Files.readAllBytes(p) : null;
        } catch (Exception e) {
          return null;
        }
      }

      public String headInject() {
        return "<script>window.__KUNET_LOCAL__={\"game\":\"t\",\"kind\":\"android\",\"name\":\"$x\"}</script>";
      }

      public void onApi(String method, String path, Map<String, String> q, CompletableFuture<LanServer.ApiResponse> res) {
        if (method.equals("POST") && path.equals("/api/rooms")) res.complete(new LanServer.ApiResponse(201, "{\"code\":\"ABCD\",\"pid\":\"" + q.get("pid") + "\"}"));
        else if (path.equals("/api/rooms/ABCD")) res.complete(new LanServer.ApiResponse(200, "{\"exists\":true,\"phase\":\"lobby\",\"freeSeats\":3}"));
        else res.complete(new LanServer.ApiResponse(200, "{\"exists\":false}"));
      }

      public void onLinkOpen(int id, String code, String pid) {
        server.send(id, "open:" + code + ":" + pid);
      }

      public void onLinkMessage(int id, String data) {
        if (data.equals("bye")) server.close(id, 4000, "bye");
        else server.send(id, "echo:" + data);
      }

      public void onLinkClose(int id) {}
    });
    int port = server.start(18900);

    LanClient.HttpResult r = LanClient.request("POST", "http://127.0.0.1:" + port + "/api/rooms?pid=p1", 3000);
    check(r.status == 201 && r.body.contains("\"code\":\"ABCD\"") && r.body.contains("p1"), "native POST /api/rooms");
    r = LanClient.request("GET", "http://127.0.0.1:" + port + "/api/rooms/ABCD", 3000);
    check(r.body.contains("\"exists\":true"), "native GET room info");
    r = LanClient.request("GET", "http://127.0.0.1:" + port + "/?sala=ABCD", 3000);
    check(r.status == 200 && r.body.contains("__KUNET_LOCAL__") && r.body.contains("$x"), "index.html with the injected script");

    final StringBuilder got = new StringBuilder();
    final CountDownLatch open = new CountDownLatch(1), echoed = new CountDownLatch(2), closed = new CountDownLatch(1);
    final int[] closeCode = {0};
    LanClient.Ws ws = LanClient.Ws.connect("ws://127.0.0.1:" + port + "/api/rooms/ABCD/ws?pid=p1", 3000, new LanClient.WsListener() {
      public void onOpen() { open.countDown(); }
      public void onMessage(String d) { synchronized (got) { got.append(d).append('\n'); } echoed.countDown(); }
      public void onClose(int c) { closeCode[0] = c; closed.countDown(); }
    });
    check(open.await(3, TimeUnit.SECONDS), "native WebSocket opens");
    ws.send("{\"t\":\"hola ñ\"}");
    check(echoed.await(3, TimeUnit.SECONDS), "frames both ways");
    synchronized (got) {
      check(got.toString().contains("open:ABCD:p1") && got.toString().contains("echo:{\"t\":\"hola ñ\"}"), "link open event and UTF-8 echo");
    }
    final String big = "x".repeat(35_000);
    final CountDownLatch bigEcho = new CountDownLatch(1);
    final CountDownLatch open2 = new CountDownLatch(1);
    LanClient.Ws ws2 = LanClient.Ws.connect("ws://127.0.0.1:" + port + "/api/rooms/ABCD/ws", 3000, new LanClient.WsListener() {
      public void onOpen() { open2.countDown(); }
      public void onMessage(String d) {
        if (d.startsWith("echo:x")) {
          check(d.length() == 5 + big.length(), "35 kB frame echoed intact");
          bigEcho.countDown();
        }
      }
      public void onClose(int c) {}
    });
    check(open2.await(3, TimeUnit.SECONDS), "second client opens");
    ws2.send(big);
    check(bigEcho.await(3, TimeUnit.SECONDS), "large frame round trip");
    ws.send("bye");
    check(closed.await(3, TimeUnit.SECONDS) && closeCode[0] == 4000, "server close code reaches the client (" + closeCode[0] + ")");
    ws2.close(1000, "done");

    System.out.println("READY " + port);
    System.out.flush();
    Thread.sleep(Long.MAX_VALUE);
  }

  static void check(boolean ok, String what) {
    System.out.println((ok ? "  ok   " : "  FAIL ") + what);
    System.out.flush();
    if (!ok) System.exit(1);
  }
}
