// OpenSpades Mobile — native UDP transport for the WebAssembly ENet client. GPL-3.0-or-later.
package app.openspadesweb.mobile;

import android.os.Handler;
import android.os.Looper;
import android.util.Base64;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.io.IOException;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.PortUnreachableException;
import java.net.SocketException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Replaces the web build's WebSocket→UDP relay: each JavaScript "socket" maps to one connected
 * DatagramSocket, and every message is exactly one ENet datagram (same framing as browser/relay.mjs).
 * Incoming datagrams are batched per UI-thread turn to keep the JS bridge cheap during map downloads.
 */
final class UdpBridge {
    interface Sink { void post(String json); }

    private static final int MAX_DATAGRAM = 65_535;
    private final Sink sink;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<Integer, Channel> channels = new ConcurrentHashMap<>();
    private final ExecutorService connector = Executors.newCachedThreadPool();

    UdpBridge(Sink sink) { this.sink = sink; }

    void handle(JSONObject m) {
        int id = m.optInt("id");
        switch (m.optString("ev")) {
            case "open": open(id, m.optString("host"), m.optInt("port")); break;
            case "send": {
                Channel c = channels.get(id);
                if (c != null) c.send(Base64.decode(m.optString("data"), Base64.NO_WRAP));
                break;
            }
            case "close": {
                Channel c = channels.remove(id);
                if (c != null) c.close(null, false);
                break;
            }
            default: break;
        }
    }

    void closeAll() {
        for (Channel c : channels.values()) c.close(null, false);
        channels.clear();
    }

    private void open(int id, String host, int port) {
        if (host.isEmpty() || host.length() > 253 || port < 1 || port > 65_535) { emitClose(id, 1008, "Invalid server address."); return; }
        connector.execute(() -> {
            try {
                InetAddress address = resolve(host);
                DatagramSocket socket = new DatagramSocket();
                socket.connect(address, port);
                Channel c = new Channel(id, socket);
                channels.put(id, c);
                c.start();
                emit(id, "open", null);
            } catch (IOException e) {
                emitClose(id, 1011, "Could not find that server (" + host + ").");
            }
        });
    }

    /** AoS servers are IPv4; prefer an A record when a name has both. */
    private static InetAddress resolve(String host) throws IOException {
        InetAddress[] all = InetAddress.getAllByName(host);
        for (InetAddress a : all) if (a instanceof Inet4Address) return a;
        return all[0];
    }

    private void emit(int id, String ev, JSONArray data) {
        try {
            JSONObject o = new JSONObject().put("op", "udp").put("ev", ev).put("id", id);
            if (data != null) o.put("data", data);
            String json = o.toString();
            main.post(() -> sink.post(json));
        } catch (JSONException ignored) { }
    }

    private void emitClose(int id, int code, String reason) {
        try {
            String json = new JSONObject().put("op", "udp").put("ev", "close").put("id", id).put("code", code).put("reason", reason == null ? "" : reason).toString();
            main.post(() -> sink.post(json));
        } catch (JSONException ignored) { }
    }

    private final class Channel {
        final int id;
        final DatagramSocket socket;
        final ExecutorService sender = Executors.newSingleThreadExecutor();
        final ConcurrentLinkedQueue<String> inbox = new ConcurrentLinkedQueue<>();
        final AtomicBoolean flushScheduled = new AtomicBoolean();
        final AtomicBoolean closed = new AtomicBoolean();
        Thread receiver;

        Channel(int id, DatagramSocket socket) { this.id = id; this.socket = socket; }

        void start() {
            receiver = new Thread(this::receiveLoop, "udp-recv-" + id);
            receiver.setDaemon(true);
            receiver.start();
        }

        void send(byte[] datagram) {
            if (closed.get()) return;
            sender.execute(() -> {
                try { socket.send(new DatagramPacket(datagram, datagram.length)); }
                catch (PortUnreachableException e) { fail("The server is not accepting connections on that port."); }
                catch (IOException e) { if (!closed.get()) fail("Network error: " + e.getMessage()); }
            });
        }

        private void receiveLoop() {
            byte[] buffer = new byte[MAX_DATAGRAM];
            DatagramPacket packet = new DatagramPacket(buffer, buffer.length);
            while (!closed.get()) {
                try {
                    packet.setLength(buffer.length);
                    socket.receive(packet);
                    inbox.add(Base64.encodeToString(buffer, 0, packet.getLength(), Base64.NO_WRAP));
                    if (flushScheduled.compareAndSet(false, true)) main.post(this::flush);
                } catch (PortUnreachableException e) {
                    fail("The server is not accepting connections on that port.");
                    return;
                } catch (SocketException e) {
                    if (!closed.get()) fail("The network connection was lost.");
                    return;
                } catch (IOException e) {
                    if (!closed.get()) fail("Network error: " + e.getMessage());
                    return;
                }
            }
        }

        /** Runs on the UI thread: forwards everything received since the last flush in one message. */
        private void flush() {
            flushScheduled.set(false);
            if (closed.get()) { inbox.clear(); return; }
            JSONArray batch = new JSONArray();
            for (String d; (d = inbox.poll()) != null; ) batch.put(d);
            if (batch.length() == 0) return;
            try {
                sink.post(new JSONObject().put("op", "udp").put("ev", "data").put("id", id).put("data", batch).toString());
            } catch (JSONException ignored) { }
        }

        private void fail(String reason) {
            if (channels.remove(id) != null) close(reason, true);
        }

        void close(String reason, boolean notify) {
            if (!closed.compareAndSet(false, true)) return;
            socket.close();
            sender.shutdownNow();
            if (notify) emitClose(id, 1011, reason);
        }
    }
}
