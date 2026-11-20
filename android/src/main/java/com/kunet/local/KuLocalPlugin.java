package com.kunet.local;

import android.content.Context;
import android.net.wifi.WifiManager;
import android.net.nsd.NsdManager;
import android.os.Build;
import android.net.nsd.NsdServiceInfo;
import android.view.WindowManager;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.atomic.AtomicInteger;
import org.json.JSONObject;

/**
 * KuLocal — local play for the Ku games (Capacitor plugin).
 *
 * Host side: one LanServer (HTTP + WebSocket) serving the app's own web build (assets/public) and the
 * room routes; JavaScript runs the room (kunet LocalHost) and answers through events:
 *   events  api {rid, method, path, query}, linkOpen {id, code, pid}, linkMessage {id, data}, linkClose {id}
 *   methods startServer, stopServer, apiRespond, send, close, advertise, stopAdvertise, keepAwake
 * Join side (app → another device; the WebView cannot use http:// or ws:// to the LAN):
 *   methods request, connect, clientSend, clientClose, discover, stopDiscovery, getAddresses
 *   events  clientOpen {id}, clientMessage {id, data}, clientClose {id, code}, found {...}, lost {key}
 */
@CapacitorPlugin(
  name = "KuLocal",
  // Nearby Connections needs different runtime permissions per Android version: one alias per group
  permissions = {
    @Permission(alias = "nearby33", strings = { "android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_ADVERTISE", "android.permission.BLUETOOTH_CONNECT", "android.permission.NEARBY_WIFI_DEVICES" }),
    @Permission(alias = "nearby31", strings = { "android.permission.BLUETOOTH_SCAN", "android.permission.BLUETOOTH_ADVERTISE", "android.permission.BLUETOOTH_CONNECT", "android.permission.ACCESS_FINE_LOCATION" }),
    @Permission(alias = "nearby29", strings = { "android.permission.ACCESS_FINE_LOCATION" }),
    @Permission(alias = "nearby23", strings = { "android.permission.ACCESS_COARSE_LOCATION" }),
  }
)
public class KuLocalPlugin extends Plugin {
  private LanServer server;
  private String game = "";
  private String hostName = "";
  private final AtomicInteger nextRid = new AtomicInteger(1);
  private final Map<Integer, CompletableFuture<LanServer.ApiResponse>> pendingApi = new ConcurrentHashMap<>();
  private final AtomicInteger nextClient = new AtomicInteger(1);
  private final Map<Integer, LanClient.Ws> clients = new ConcurrentHashMap<>();
  private NsdManager nsd;
  private NsdManager.RegistrationListener registration;
  private NsdManager.DiscoveryListener discovery;
  private final ConcurrentLinkedQueue<NsdServiceInfo> toResolve = new ConcurrentLinkedQueue<>();
  private volatile boolean resolving;
  /**
   * Android's Wi-Fi power saving lets the radio doze between packets: on a quiet table a frame can wait
   * hundreds of ms (worse on slower phones and through a laptop hotspot). While this device hosts or is
   * joined to a room it holds a low-latency Wi-Fi lock (released as soon as neither is true).
   */
  private WifiManager.WifiLock wifiLock;

  @SuppressWarnings("deprecation")
  private synchronized void updateWifiLock() {
    boolean need = (server != null && server.isRunning()) || !clients.isEmpty() || (nearby != null && nearby.busy());
    try {
      if (need && wifiLock == null) {
        WifiManager wm = (WifiManager) getContext().getApplicationContext().getSystemService(Context.WIFI_SERVICE);
        if (wm == null) return;
        int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
        wifiLock = wm.createWifiLock(mode, "kunet:local-play");
        wifiLock.setReferenceCounted(false);
        wifiLock.acquire();
      } else if (!need && wifiLock != null) {
        if (wifiLock.isHeld()) wifiLock.release();
        wifiLock = null;
      }
    } catch (Exception ignored) {
      // no Wi-Fi service / permission: play on without the lock
    }
  }

  // ───────────────────────── host ─────────────────────────

  @PluginMethod
  public void startServer(PluginCall call) {
    game = call.getString("game", "");
    hostName = call.getString("name", "");
    int port = call.getInt("port", 8787);
    try {
      if (server == null) server = new LanServer(handler);
      int p = server.start(port);
      updateWifiLock();
      JSObject r = new JSObject();
      r.put("port", p);
      r.put("origins", JSArray.from(origins(p).toArray()));
      call.resolve(r);
    } catch (Exception e) {
      call.reject("could not start the server: " + e.getMessage(), "start_failed");
    }
  }

  @PluginMethod
  public void stopServer(PluginCall call) {
    if (server != null) server.stop();
    for (CompletableFuture<LanServer.ApiResponse> f : pendingApi.values()) f.complete(new LanServer.ApiResponse(503, "{\"error\":\"stopped\"}"));
    pendingApi.clear();
    updateWifiLock();
    call.resolve();
  }

  @PluginMethod
  public void apiRespond(PluginCall call) {
    CompletableFuture<LanServer.ApiResponse> f = pendingApi.remove(call.getInt("rid", -1));
    if (f != null) f.complete(new LanServer.ApiResponse(call.getInt("status", 200), call.getString("json", "{}")));
    call.resolve();
  }

  @PluginMethod
  public void send(PluginCall call) {
    if (server != null) server.send(call.getInt("id", -1), call.getString("data", ""));
    call.resolve();
  }

  @PluginMethod
  public void close(PluginCall call) {
    if (server != null) server.close(call.getInt("id", -1), call.getInt("code", 1000), call.getString("reason", ""));
    call.resolve();
  }

  private final LanServer.Handler handler = new LanServer.Handler() {
    @Override
    public byte[] readAsset(String path) {
      try (InputStream in = getContext().getAssets().open("public/" + path)) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] b = new byte[16384];
        int k;
        while ((k = in.read(b)) > 0) out.write(b, 0, k);
        return out.toByteArray();
      } catch (IOException e) {
        return null;
      }
    }

    @Override
    public String headInject() {
      try {
        JSONObject o = new JSONObject();
        o.put("game", game);
        o.put("kind", "android");
        o.put("name", hostName);
        o.put("origins", new org.json.JSONArray(origins(server.port())));
        // "</" cannot appear in names we put here, but never let a value end the script
        return "<script>window.__KUNET_LOCAL__=" + o.toString().replace("</", "<\\/") + "</script>";
      } catch (Exception e) {
        return "";
      }
    }

    @Override
    public void onApi(String method, String path, Map<String, String> query, CompletableFuture<LanServer.ApiResponse> res) {
      int rid = nextRid.getAndIncrement();
      pendingApi.put(rid, res);
      JSObject q = new JSObject();
      for (Map.Entry<String, String> e : query.entrySet()) q.put(e.getKey(), e.getValue());
      JSObject ev = new JSObject();
      ev.put("rid", rid);
      ev.put("method", method);
      ev.put("path", path);
      ev.put("query", q);
      notifyListeners("api", ev);
      res.whenComplete((r, t) -> pendingApi.remove(rid));
    }

    @Override
    public void onLinkOpen(int id, String code, String pid) {
      JSObject ev = new JSObject();
      ev.put("id", id);
      ev.put("code", code);
      ev.put("pid", pid == null ? JSONObject.NULL : pid);
      notifyListeners("linkOpen", ev);
    }

    @Override
    public void onLinkMessage(int id, String data) {
      JSObject ev = new JSObject();
      ev.put("id", id);
      ev.put("data", data);
      notifyListeners("linkMessage", ev);
    }

    @Override
    public void onLinkClose(int id) {
      JSObject ev = new JSObject();
      ev.put("id", id);
      notifyListeners("linkClose", ev);
    }
  };

  /** the host keeps its screen on while it holds a room */
  @PluginMethod
  public void keepAwake(PluginCall call) {
    final boolean on = Boolean.TRUE.equals(call.getBoolean("on", true));
    getActivity().runOnUiThread(() -> {
      if (on) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
      else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
    });
    call.resolve();
  }

  // ───────────────────────── addresses ─────────────────────────

  @PluginMethod
  public void getAddresses(PluginCall call) {
    JSArray list = new JSArray();
    for (String[] a : addresses()) {
      JSObject o = new JSObject();
      o.put("name", a[0]);
      o.put("address", a[1]);
      list.put(o);
    }
    JSObject r = new JSObject();
    r.put("addresses", list);
    call.resolve(r);
  }

  /** [interface, IPv4] other devices can reach: Wi-Fi first, then the hotspot, then the rest */
  private static List<String[]> addresses() {
    List<String[]> out = new ArrayList<>();
    try {
      for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
        if (!ni.isUp() || ni.isLoopback()) continue;
        String name = ni.getName();
        if (name.startsWith("rmnet") || name.startsWith("ccmni") || name.startsWith("dummy") || name.startsWith("tun")) continue; // mobile data, VPN
        for (InetAddress a : Collections.list(ni.getInetAddresses())) {
          if (a instanceof Inet4Address && !a.isLoopbackAddress() && !a.isLinkLocalAddress()) out.add(new String[] {name, a.getHostAddress()});
        }
      }
    } catch (Exception ignored) {
    }
    Collections.sort(out, (x, y) -> rank(x[0]) - rank(y[0]));
    return out;
  }

  private static int rank(String name) {
    if (name.startsWith("wlan0")) return 0;
    if (name.startsWith("wlan") || name.startsWith("swlan") || name.startsWith("ap")) return 1;
    if (name.startsWith("eth")) return 2;
    return 3;
  }

  private static List<String> origins(int port) {
    List<String> out = new ArrayList<>();
    for (String[] a : addresses()) out.add("http://" + a[1] + ":" + port);
    return out;
  }

  // ───────────────────────── discovery (NSD / mDNS) ─────────────────────────

  private NsdManager nsd() {
    if (nsd == null) nsd = (NsdManager) getContext().getSystemService(Context.NSD_SERVICE);
    return nsd;
  }

  /** advertise this host as "_<type>._tcp" with TXT code / name (type: the game id) */
  @PluginMethod
  public void advertise(PluginCall call) {
    stopAdvertising();
    NsdServiceInfo info = new NsdServiceInfo();
    info.setServiceName(call.getString("name", "Ku") + " · " + call.getString("code", ""));
    info.setServiceType("_" + call.getString("type", "kunet") + "._tcp");
    info.setPort(call.getInt("port", server == null ? 8787 : server.port()));
    info.setAttribute("code", call.getString("code", ""));
    info.setAttribute("name", call.getString("name", ""));
    registration = new NsdManager.RegistrationListener() {
      public void onServiceRegistered(NsdServiceInfo i) {}
      public void onRegistrationFailed(NsdServiceInfo i, int err) {}
      public void onServiceUnregistered(NsdServiceInfo i) {}
      public void onUnregistrationFailed(NsdServiceInfo i, int err) {}
    };
    try {
      nsd().registerService(info, NsdManager.PROTOCOL_DNS_SD, registration);
      call.resolve();
    } catch (Exception e) {
      registration = null;
      call.reject("advertise failed: " + e.getMessage(), "advertise_failed");
    }
  }

  @PluginMethod
  public void stopAdvertise(PluginCall call) {
    stopAdvertising();
    call.resolve();
  }

  private void stopAdvertising() {
    if (registration == null) return;
    try {
      nsd().unregisterService(registration);
    } catch (Exception ignored) {
    }
    registration = null;
  }

  @PluginMethod
  public void discover(PluginCall call) {
    stopDiscovering();
    final String type = "_" + call.getString("type", "kunet") + "._tcp";
    discovery = new NsdManager.DiscoveryListener() {
      public void onDiscoveryStarted(String t) {}
      public void onDiscoveryStopped(String t) {}
      public void onStartDiscoveryFailed(String t, int err) {}
      public void onStopDiscoveryFailed(String t, int err) {}
      public void onServiceFound(NsdServiceInfo s) {
        toResolve.add(s);
        resolveNext();
      }
      public void onServiceLost(NsdServiceInfo s) {
        JSObject ev = new JSObject();
        ev.put("key", s.getServiceName());
        notifyListeners("lost", ev);
      }
    };
    try {
      nsd().discoverServices(type, NsdManager.PROTOCOL_DNS_SD, discovery);
      call.resolve();
    } catch (Exception e) {
      discovery = null;
      call.reject("discovery failed: " + e.getMessage(), "discover_failed");
    }
  }

  @PluginMethod
  public void stopDiscovery(PluginCall call) {
    stopDiscovering();
    call.resolve();
  }

  private void stopDiscovering() {
    if (discovery == null) return;
    try {
      nsd().stopServiceDiscovery(discovery);
    } catch (Exception ignored) {
    }
    discovery = null;
    toResolve.clear();
  }

  /** NsdManager resolves one service at a time (older Android fails a second concurrent resolve) */
  @SuppressWarnings("deprecation")
  private synchronized void resolveNext() {
    if (resolving) return;
    final NsdServiceInfo s = toResolve.poll();
    if (s == null) return;
    resolving = true;
    nsd().resolveService(s, new NsdManager.ResolveListener() {
      public void onResolveFailed(NsdServiceInfo i, int err) {
        done();
      }

      public void onServiceResolved(NsdServiceInfo i) {
        InetAddress host = i.getHost();
        if (host instanceof Inet4Address) {
          JSObject ev = new JSObject();
          ev.put("key", i.getServiceName());
          ev.put("host", host.getHostAddress());
          ev.put("port", i.getPort());
          Map<String, byte[]> attrs = i.getAttributes();
          ev.put("code", attrs.get("code") == null ? "" : new String(attrs.get("code"), StandardCharsets.UTF_8));
          ev.put("name", attrs.get("name") == null ? "" : new String(attrs.get("name"), StandardCharsets.UTF_8));
          notifyListeners("found", ev);
        }
        done();
      }

      private void done() {
        synchronized (KuLocalPlugin.this) {
          resolving = false;
        }
        resolveNext();
      }
    });
  }

  // ───────────────────────── join side: HTTP + WebSocket client ─────────────────────────

  @PluginMethod
  public void request(final PluginCall call) {
    final String method = call.getString("method", "GET");
    final String url = call.getString("url", "");
    new Thread(() -> {
      try {
        LanClient.HttpResult r = LanClient.request(method, url, call.getInt("timeoutMs", 5000));
        JSObject o = new JSObject();
        o.put("status", r.status);
        o.put("body", r.body);
        call.resolve(o);
      } catch (Exception e) {
        call.reject("offline", "offline");
      }
    }, "kunet-request").start();
  }

  @PluginMethod
  public void connect(PluginCall call) {
    final int id = nextClient.getAndIncrement();
    LanClient.Ws ws = LanClient.Ws.connect(call.getString("url", ""), call.getInt("timeoutMs", 6000), new LanClient.WsListener() {
      public void onOpen() {
        JSObject ev = new JSObject();
        ev.put("id", id);
        notifyListeners("clientOpen", ev);
      }

      public void onMessage(String data) {
        JSObject ev = new JSObject();
        ev.put("id", id);
        ev.put("data", data);
        notifyListeners("clientMessage", ev);
      }

      public void onClose(int code) {
        clients.remove(id);
        updateWifiLock();
        JSObject ev = new JSObject();
        ev.put("id", id);
        ev.put("code", code);
        notifyListeners("clientClose", ev);
      }
    });
    clients.put(id, ws);
    updateWifiLock();
    JSObject r = new JSObject();
    r.put("id", id);
    call.resolve(r);
  }

  @PluginMethod
  public void clientSend(PluginCall call) {
    LanClient.Ws ws = clients.get(call.getInt("id", -1));
    if (ws != null) ws.send(call.getString("data", ""));
    call.resolve();
  }

  @PluginMethod
  public void clientClose(PluginCall call) {
    LanClient.Ws ws = clients.remove(call.getInt("id", -1));
    if (ws != null) ws.close(call.getInt("code", 1000), call.getString("reason", ""));
    updateWifiLock();
    call.resolve();
  }

  // ───────────────────────── Nearby Connections (Bluetooth, no network needed) ─────────────────────────

  private NearbyHub nearby;

  private static String nearbyAlias() {
    if (Build.VERSION.SDK_INT >= 33) return "nearby33";
    if (Build.VERSION.SDK_INT >= 31) return "nearby31";
    if (Build.VERSION.SDK_INT >= 29) return "nearby29";
    return "nearby23";
  }

  private NearbyHub nearby() {
    if (nearby == null) {
      nearby = new NearbyHub(getContext(), new NearbyHub.Events() {
        public void found(String id, String name) {
          JSObject e = new JSObject();
          e.put("id", id);
          e.put("name", name);
          notifyListeners("nearbyFound", e);
        }

        public void lost(String id) {
          JSObject e = new JSObject();
          e.put("id", id);
          notifyListeners("nearbyLost", e);
        }

        public void open(String id, boolean incoming) {
          JSObject e = new JSObject();
          e.put("id", id);
          e.put("incoming", incoming);
          notifyListeners("nearbyOpen", e);
          updateWifiLock();
        }

        public void data(String id, String data) {
          JSObject e = new JSObject();
          e.put("id", id);
          e.put("data", data);
          notifyListeners("nearbyData", e);
        }

        public void close(String id) {
          JSObject e = new JSObject();
          e.put("id", id);
          notifyListeners("nearbyClose", e);
        }

        public void error(String where, String message) {
          JSObject e = new JSObject();
          e.put("where", where);
          e.put("message", message == null ? "" : message);
          notifyListeners("nearbyError", e);
        }
      });
    }
    return nearby;
  }

  /** {request?: boolean} -> {granted}: asks Android only when request is true and not granted yet */
  @PluginMethod
  public void nearbyPermission(PluginCall call) {
    String alias = nearbyAlias();
    if (getPermissionState(alias) == PermissionState.GRANTED || !Boolean.TRUE.equals(call.getBoolean("request", false))) {
      JSObject r = new JSObject();
      r.put("granted", getPermissionState(alias) == PermissionState.GRANTED);
      call.resolve(r);
      return;
    }
    requestPermissionForAlias(alias, call, "nearbyPermissionResult");
  }

  @PermissionCallback
  private void nearbyPermissionResult(PluginCall call) {
    JSObject r = new JSObject();
    r.put("granted", getPermissionState(nearbyAlias()) == PermissionState.GRANTED);
    call.resolve(r);
  }

  private boolean nearbyAllowed(PluginCall call) {
    if (getPermissionState(nearbyAlias()) == PermissionState.GRANTED) return true;
    call.reject("nearby permission not granted", "no_permission");
    return false;
  }

  @PluginMethod
  public void nearbyAdvertise(PluginCall call) {
    if (!nearbyAllowed(call)) return;
    try {
      nearby().stopAdvertising();
      nearby().advertise(call.getString("code", "") + "|" + call.getString("name", ""), "kunet." + call.getString("game", "kunet"));
      call.resolve();
    } catch (Exception e) {
      call.reject("advertise failed: " + e.getMessage(), "nearby_failed");
    }
  }

  @PluginMethod
  public void nearbyStopAdvertise(PluginCall call) {
    if (nearby != null) nearby.stopAdvertising();
    call.resolve();
  }

  @PluginMethod
  public void nearbyDiscover(PluginCall call) {
    if (!nearbyAllowed(call)) return;
    try {
      nearby().stopDiscovery();
      nearby().discover("kunet." + call.getString("game", "kunet"));
      call.resolve();
    } catch (Exception e) {
      call.reject("discovery failed: " + e.getMessage(), "nearby_failed");
    }
  }

  @PluginMethod
  public void nearbyStopDiscovery(PluginCall call) {
    if (nearby != null) nearby.stopDiscovery();
    call.resolve();
  }

  @PluginMethod
  public void nearbyConnect(PluginCall call) {
    if (!nearbyAllowed(call)) return;
    nearby().connect(call.getString("name", "Ku"), call.getString("id", ""));
    call.resolve();
  }

  @PluginMethod
  public void nearbySend(PluginCall call) {
    if (nearby != null) nearby.send(call.getString("id", ""), call.getString("data", ""));
    call.resolve();
  }

  @PluginMethod
  public void nearbyDisconnect(PluginCall call) {
    if (nearby != null) nearby.disconnect(call.getString("id", ""));
    updateWifiLock();
    call.resolve();
  }

  @PluginMethod
  public void nearbyStop(PluginCall call) {
    if (nearby != null) nearby.stopAll();
    updateWifiLock();
    call.resolve();
  }

  @Override
  protected void handleOnDestroy() {
    if (nearby != null) nearby.stopAll();
    stopAdvertising();
    stopDiscovering();
    if (server != null) server.stop();
    for (LanClient.Ws ws : clients.values()) ws.close(1001, "app_closed");
    clients.clear();
    updateWifiLock();
  }
}
