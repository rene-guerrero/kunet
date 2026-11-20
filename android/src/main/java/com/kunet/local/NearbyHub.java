package com.kunet.local;

import android.content.Context;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionOptions;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.ConnectionsStatusCodes;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;
import java.nio.charset.StandardCharsets;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Google Nearby Connections for local play without any network: phones find each other over
 * Bluetooth / BLE and Nearby may move the link to Wi-Fi Direct. Star topology (P2P_STAR): one host,
 * several joiners. Connections are accepted automatically (a family table game, no pairing codes).
 * Payloads are UTF-8 strings (BYTES payloads); framing and chunking live in JavaScript (kunet/native).
 */
final class NearbyHub {
  interface Events {
    void found(String id, String endpointName);

    void lost(String id);

    void open(String id, boolean incoming);

    void data(String id, String data);

    void close(String id);

    void error(String where, String message);
  }

  private final ConnectionsClient client;
  private final Events ev;
  /** endpoints whose connection completed */
  private final Set<String> connected = ConcurrentHashMap.newKeySet();
  /** endpoints we asked to connect to (joiner side) */
  private final Set<String> outgoing = ConcurrentHashMap.newKeySet();

  NearbyHub(Context ctx, Events ev) {
    this.client = Nearby.getConnectionsClient(ctx);
    this.ev = ev;
  }

  private final PayloadCallback payloads = new PayloadCallback() {
    @Override
    public void onPayloadReceived(String id, Payload p) {
      if (p.getType() != Payload.Type.BYTES || p.asBytes() == null) return;
      ev.data(id, new String(p.asBytes(), StandardCharsets.UTF_8));
    }

    @Override
    public void onPayloadTransferUpdate(String id, PayloadTransferUpdate u) {}
  };

  private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
    @Override
    public void onConnectionInitiated(String id, ConnectionInfo info) {
      client.acceptConnection(id, payloads).addOnFailureListener((e) -> ev.error("accept", e.getMessage()));
    }

    @Override
    public void onConnectionResult(String id, ConnectionResolution r) {
      boolean mine = outgoing.remove(id);
      if (r.getStatus().getStatusCode() == ConnectionsStatusCodes.STATUS_OK) {
        connected.add(id);
        ev.open(id, !mine);
      } else if (mine) ev.close(id); // our request failed: the joiner hears a close
    }

    @Override
    public void onDisconnected(String id) {
      connected.remove(id);
      ev.close(id);
    }
  };

  void advertise(String endpointName, String serviceId) {
    AdvertisingOptions o = new AdvertisingOptions.Builder().setStrategy(Strategy.P2P_STAR).setDisruptiveUpgrade(false).build();
    client.startAdvertising(endpointName, serviceId, lifecycle, o).addOnFailureListener((e) -> ev.error("advertise", e.getMessage()));
  }

  void stopAdvertising() {
    client.stopAdvertising();
  }

  void discover(String serviceId) {
    DiscoveryOptions o = new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_STAR).build();
    client.startDiscovery(serviceId, new EndpointDiscoveryCallback() {
      @Override
      public void onEndpointFound(String id, DiscoveredEndpointInfo info) {
        ev.found(id, info.getEndpointName());
      }

      @Override
      public void onEndpointLost(String id) {
        ev.lost(id);
      }
    }, o).addOnFailureListener((e) -> ev.error("discover", e.getMessage()));
  }

  void stopDiscovery() {
    client.stopDiscovery();
  }

  /** joiner: connect to a found host; already connected → open is reported again at once */
  void connect(String myName, String id) {
    if (connected.contains(id)) {
      ev.open(id, false);
      return;
    }
    outgoing.add(id);
    // keep the phones on their current Wi-Fi: no disruptive switch to a Wi-Fi Direct / hotspot link
    ConnectionOptions o = new ConnectionOptions.Builder().setDisruptiveUpgrade(false).build();
    client.requestConnection(myName, id, lifecycle, o).addOnFailureListener((e) -> {
      // already connected / pending counts as success; anything else closes
      if (e instanceof com.google.android.gms.common.api.ApiException
          && ((com.google.android.gms.common.api.ApiException) e).getStatusCode() == ConnectionsStatusCodes.STATUS_ALREADY_CONNECTED_TO_ENDPOINT) {
        outgoing.remove(id);
        connected.add(id);
        ev.open(id, false);
        return;
      }
      outgoing.remove(id);
      ev.error("connect", e.getMessage());
      ev.close(id);
    });
  }

  void send(String id, String data) {
    client.sendPayload(id, Payload.fromBytes(data.getBytes(StandardCharsets.UTF_8))).addOnFailureListener((e) -> ev.error("send", e.getMessage()));
  }

  void disconnect(String id) {
    client.disconnectFromEndpoint(id);
    if (connected.remove(id)) ev.close(id);
  }

  void stopAll() {
    client.stopAdvertising();
    client.stopDiscovery();
    client.stopAllEndpoints();
    connected.clear();
    outgoing.clear();
  }

  boolean busy() {
    return !connected.isEmpty();
  }
}
