// OpenSpades Helper for Android: a WebSocket-to-UDP relay on 127.0.0.1. GPL-3.0-or-later.
//
// The same protocol and rules as the desktop helper (browser/helper/src/main.rs):
//   GET /health   {"helper":"openspades","version":1} with CORS for the allowed origins (page detection)
//   GET /relay    ?host=<ip or name>&port=<port>, WebSocket; one binary message = one UDP datagram, both ways
// Only pages from the allowed origins may use it (any web page can reach 127.0.0.1): BuildConfig.ORIGINS
// (OSHELPER_ORIGINS at build time) plus local test pages on http://127.0.0.1 and http://localhost. Only public
// IPv4 addresses are relayed.
package io.github.sgtmetz.openspadeshelper;

import android.util.Base64;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.DatagramPacket;
import java.net.DatagramSocket;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.SocketTimeoutException;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicLong;

final class Relay {
    static final int PORT = 32880;
    static final int VERSION = 1;
    private static final int IDLE_MS = 60_000;
    private static final int MAX_CONNECTIONS = 64;
    private static final String GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

    /** Called on a relay thread whenever the number of open game connections changes. */
    interface Listener { void onConnections(int open); }

    private final Listener listener;
    private final AtomicInteger active = new AtomicInteger();
    private final AtomicInteger games = new AtomicInteger();
    private volatile ServerSocket server;

    Relay(Listener listener) { this.listener = listener; }

    /** Binds 127.0.0.1:32880 and serves on a background thread. Throws if the port is taken. */
    void start() throws IOException {
        ServerSocket s = new ServerSocket();
        s.setReuseAddress(true);
        s.bind(new InetSocketAddress(InetAddress.getByName("127.0.0.1"), PORT));
        server = s;
        Thread t = new Thread(() -> {
            while (!s.isClosed()) {
                try {
                    Socket c = s.accept();
                    if (active.get() >= MAX_CONNECTIONS) { c.close(); continue; }
                    Thread h = new Thread(() -> {
                        active.incrementAndGet();
                        try { handle(c); } catch (IOException ignored) {
                        } finally {
                            active.decrementAndGet();
                            try { c.close(); } catch (IOException ignored) {}
                        }
                    }, "helper-conn");
                    h.setDaemon(true);
                    h.start();
                } catch (IOException e) {
                    if (s.isClosed()) break;
                }
            }
        }, "helper-accept");
        t.setDaemon(true);
        t.start();
    }

    void stop() {
        ServerSocket s = server;
        server = null;
        if (s != null) try { s.close(); } catch (IOException ignored) {}
    }

    static List<String> allowedList() {
        List<String> list = new ArrayList<>();
        for (String o : BuildConfig.ORIGINS.split(",")) if (!o.trim().isEmpty()) list.add(o.trim());
        list.add("http://127.0.0.1:*");
        list.add("http://localhost:*");
        return list;
    }

    static boolean originAllowed(String origin) {
        for (String o : allowedList()) if (o.equals(origin)) return true;
        for (String local : new String[] {"http://127.0.0.1", "http://localhost"}) {
            if (origin.startsWith(local)) {
                String rest = origin.substring(local.length());
                if (rest.isEmpty() || (rest.startsWith(":") && rest.length() > 1 && rest.substring(1).chars().allMatch(Character::isDigit))) return true;
            }
        }
        return false;
    }

    private static final class Request {
        String method = "", path = "";
        final Map<String, String> query = new HashMap<>(), headers = new HashMap<>();
    }

    private static Request readRequest(InputStream in) throws IOException {
        ByteArrayOutputStream data = new ByteArrayOutputStream();
        int a = 0, b = 0, c = 0, d;
        while (true) {
            d = in.read();
            if (d < 0 || data.size() > 8192) throw new IOException("bad request");
            data.write(d);
            if (a == '\r' && b == '\n' && c == '\r' && d == '\n') break;
            a = b; b = c; c = d;
        }
        String[] lines = data.toString("ISO-8859-1").split("\r\n");
        Request r = new Request();
        String[] first = lines[0].split(" ");
        if (first.length > 0) r.method = first[0];
        String target = first.length > 1 ? first[1] : "";
        int q = target.indexOf('?');
        r.path = q < 0 ? target : target.substring(0, q);
        if (q >= 0) for (String kv : target.substring(q + 1).split("&")) {
            int e = kv.indexOf('=');
            if (e > 0) r.query.put(kv.substring(0, e), kv.substring(e + 1));
        }
        for (int i = 1; i < lines.length; i++) {
            int e = lines[i].indexOf(':');
            if (e > 0) r.headers.put(lines[i].substring(0, e).trim().toLowerCase(Locale.ROOT), lines[i].substring(e + 1).trim());
        }
        return r;
    }

    private static void respond(OutputStream out, String status, String extra, String body) throws IOException {
        byte[] b = body.getBytes(StandardCharsets.UTF_8);
        out.write(("HTTP/1.1 " + status + "\r\n" + extra + "Content-Length: " + b.length + "\r\nConnection: close\r\n\r\n")
            .getBytes(StandardCharsets.ISO_8859_1));
        out.write(b);
        out.flush();
    }

    private void handle(Socket sock) throws IOException {
        sock.setSoTimeout(10_000);
        InputStream in = new BufferedInputStream(sock.getInputStream());
        OutputStream out = sock.getOutputStream();
        Request req = readRequest(in);
        String origin = req.headers.getOrDefault("origin", "");
        boolean allowed = originAllowed(origin);
        // CORS for the page's detection request; Chrome's local network access checks want the
        // private-network header on loopback answers to public pages.
        String cors = allowed ? "Access-Control-Allow-Origin: " + origin + "\r\nVary: Origin\r\nAccess-Control-Allow-Private-Network: true\r\n"
            + "Access-Control-Allow-Methods: GET\r\nCross-Origin-Resource-Policy: cross-origin\r\n" : "";
        if (req.method.equals("OPTIONS")) { respond(out, "204 No Content", cors, ""); return; }
        if (req.method.equals("GET") && req.path.equals("/health")) {
            respond(out, "200 OK", cors + "Content-Type: application/json\r\nCache-Control: no-store\r\n",
                "{\"helper\":\"openspades\",\"version\":" + VERSION + "}");
            return;
        }
        if (!(req.method.equals("GET") && req.path.equals("/relay"))) { respond(out, "404 Not Found", "", ""); return; }
        if (!allowed) { respond(out, "403 Forbidden", "", ""); return; }
        String host = req.query.getOrDefault("host", "");
        int port;
        try { port = Integer.parseInt(req.query.getOrDefault("port", "0")); } catch (NumberFormatException e) { port = 0; }
        String key = req.headers.getOrDefault("sec-websocket-key", "");
        boolean upgrade = "websocket".equalsIgnoreCase(req.headers.getOrDefault("upgrade", ""));
        if (key.isEmpty() || !upgrade || host.isEmpty() || host.length() > 253 || port <= 0 || port > 65535
            || !host.chars().allMatch(ch -> (ch < 128 && Character.isLetterOrDigit(ch)) || ch == '.' || ch == '-')) {
            respond(out, "400 Bad Request", "", "");
            return;
        }
        String accept;
        try {
            accept = Base64.encodeToString(MessageDigest.getInstance("SHA-1").digest((key + GUID).getBytes(StandardCharsets.ISO_8859_1)), Base64.NO_WRAP);
        } catch (Exception e) { throw new IOException(e); }
        out.write(("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " + accept + "\r\n\r\n")
            .getBytes(StandardCharsets.ISO_8859_1));
        out.flush();
        sock.setTcpNoDelay(true);
        listener.onConnections(games.incrementAndGet());
        try { relay(sock, in, out, host, port); } finally { listener.onConnections(games.decrementAndGet()); }
    }

    static boolean isPublic(byte[] ip) {
        int a = ip[0] & 255, b = ip[1] & 255;
        return !(a == 0 || a == 10 || a == 127 || a >= 224 || (a == 100 && b >= 64 && b < 128) || (a == 169 && b == 254)
            || (a == 172 && b >= 16 && b < 32) || (a == 192 && b == 168) || (a == 198 && (b == 18 || b == 19)));
    }

    private static byte[] frame(int opcode, byte[] payload, int n) {
        int head = n < 126 ? 2 : n < 65536 ? 4 : 10;
        byte[] f = new byte[head + n];
        f[0] = (byte) (0x80 | opcode);
        if (n < 126) f[1] = (byte) n;
        else if (n < 65536) { f[1] = 126; f[2] = (byte) (n >> 8); f[3] = (byte) n; }
        else { f[1] = 127; for (int i = 0; i < 8; i++) f[2 + i] = (byte) ((long) n >> (56 - 8 * i)); }
        System.arraycopy(payload, 0, f, head, n);
        return f;
    }

    private static void send(OutputStream out, byte[] f) throws IOException {
        synchronized (out) { out.write(f); out.flush(); }
    }

    private static void close(OutputStream out, int code) {
        try { send(out, frame(0x8, new byte[] {(byte) (code >> 8), (byte) code}, 2)); } catch (IOException ignored) {}
    }

    private void relay(Socket sock, InputStream rawIn, OutputStream out, String host, int port) throws IOException {
        InetAddress target = null;
        try {
            for (InetAddress a : InetAddress.getAllByName(host)) if (a instanceof Inet4Address) { target = a; break; }
        } catch (IOException ignored) {}
        if (target == null) { close(out, 1011); return; }
        if (!isPublic(target.getAddress())) { close(out, 1008); return; }
        DatagramSocket udp = new DatagramSocket();
        udp.connect(target, port);
        udp.setSoTimeout(500);
        AtomicBoolean closed = new AtomicBoolean();
        AtomicLong last = new AtomicLong(System.currentTimeMillis());

        // UDP -> WebSocket
        Thread receiver = new Thread(() -> {
            byte[] buf = new byte[65536];
            DatagramPacket p = new DatagramPacket(buf, buf.length);
            while (!closed.get()) {
                try {
                    p.setLength(buf.length);
                    udp.receive(p);
                    last.set(System.currentTimeMillis());
                    send(out, frame(0x2, buf, p.getLength()));
                } catch (SocketTimeoutException e) {
                    if (System.currentTimeMillis() - last.get() > IDLE_MS) break;
                } catch (java.net.PortUnreachableException e) {
                    // ICMP port unreachable: keep going, like UDP
                } catch (IOException e) {
                    if (closed.get() || sock.isClosed()) break;
                }
            }
            closed.set(true);
            try { sock.close(); } catch (IOException ignored) {}
        }, "helper-udp");
        receiver.setDaemon(true);
        receiver.start();

        // WebSocket -> UDP
        DataInputStream in = new DataInputStream(rawIn);
        sock.setSoTimeout(IDLE_MS);
        ByteArrayOutputStream fragments = new ByteArrayOutputStream();
        try {
            while (true) {
                int b0 = in.readUnsignedByte(), b1 = in.readUnsignedByte();
                boolean fin = (b0 & 0x80) != 0, masked = (b1 & 0x80) != 0;
                int opcode = b0 & 0x0f;
                long len = b1 & 0x7f;
                if (len == 126) len = in.readUnsignedShort();
                else if (len == 127) len = in.readLong();
                if (!masked || len < 0 || len > 1 << 20) { close(out, 1002); return; }
                byte[] mask = new byte[4];
                in.readFully(mask);
                byte[] payload = new byte[(int) len];
                in.readFully(payload);
                for (int i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
                if (opcode == 0x8) { close(out, 1000); return; }
                if (opcode == 0x9) { send(out, frame(0xA, payload, payload.length)); continue; }
                if (opcode == 0xA) continue;
                fragments.write(payload);
                if (!fin) continue;
                last.set(System.currentTimeMillis());
                byte[] d = fragments.toByteArray();
                fragments.reset();
                try { udp.send(new DatagramPacket(d, d.length)); } catch (IOException ignored) {}
            }
        } catch (EOFException | SocketTimeoutException ignored) {
        } finally {
            closed.set(true);
            udp.close();
            try { receiver.join(1000); } catch (InterruptedException ignored) {}
        }
    }
}
