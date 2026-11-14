// Browser transport for the unmodified original NetClient. GPL-3.0-or-later.
// Upstream ENet keeps packet framing, reliability, compression and timeouts; only the
// platform layer (unix.c/win32.c equivalent) is replaced. Browsers cannot send UDP, so each
// datagram is one binary WebSocket message to the relay (relay.mjs), which forwards it over
// UDP to the server and resolves host names there.
//
// The client loop runs on a pthread that never returns to its JavaScript event loop, so a
// WebSocket owned by that worker would never deliver open/message events. The sockets
// therefore live on the main thread (Module.osFullNet) and the pthread reaches them through
// synchronous proxied calls; received datagrams are copied straight into ENet's buffer.
#define os_js_udp_send os_unused_udp_send
#define os_js_udp_receive os_unused_udp_receive
#define enet_address_set_host os_unused_address_set_host
#define enet_address_set_host_ip os_unused_address_set_host_ip
#define enet_address_get_host os_unused_address_get_host
#define enet_address_get_host_ip os_unused_address_get_host_ip
#define enet_socket_create os_unused_socket_create
#define enet_socket_destroy os_unused_socket_destroy
#define enet_socket_send os_unused_socket_send
#define enet_socket_receive os_unused_socket_receive
#include "../native/enet_browser.c"
#undef os_js_udp_send
#undef os_js_udp_receive
#undef enet_address_set_host
#undef enet_address_set_host_ip
#undef enet_address_get_host
#undef enet_address_get_host_ip
#undef enet_socket_create
#undef enet_socket_destroy
#undef enet_socket_send
#undef enet_socket_receive
#include <stdio.h>
#include <stdlib.h>
#include <stdatomic.h>
#include <emscripten/em_asm.h>
#include <emscripten/threading.h>

// Host names cannot be resolved in the browser. Like getaddrinfo, a name maps to an address,
// here a placeholder in 240.0.0.0/8 (reserved, never a real server) that the transport turns
// back into the name for the relay. Dotted IPv4 literals map to themselves, so addresses that
// ServerAddress parses as integers (names without dots) keep their numeric meaning.
#define OS_NAME_SLOTS 64
static char os_names[OS_NAME_SLOTS][254];
static int os_name_count;

static int os_parse_ipv4(const char *name, enet_uint32 *host) {
  unsigned parts[4]; int count = 0; const char *p = name;
  while (count < 4) {
    if (*p < '0' || *p > '9') return -1;
    unsigned value = 0; int digits = 0;
    while (*p >= '0' && *p <= '9') { value = value * 10 + (unsigned)(*p++ - '0'); if (++digits > 3) return -1; }
    if (value > 255) return -1;
    parts[count++] = value;
    if (count < 4) { if (*p++ != '.') return -1; }
  }
  if (*p) return -1;
  *host = parts[0] | parts[1] << 8 | parts[2] << 16 | (enet_uint32)parts[3] << 24;
  return 0;
}

static int os_is_name_placeholder(enet_uint32 host) {
  return (host & 0x00FFFFFF) == 0xF0 && (host >> 24) >= 1 && (int)(host >> 24) <= os_name_count;
}

int enet_address_set_host_ip(ENetAddress *address, const char *name) {
  return os_parse_ipv4(name, &address->host);
}

int enet_address_set_host(ENetAddress *address, const char *name) {
  if (os_parse_ipv4(name, &address->host) == 0) return 0;
  size_t length = strlen(name);
  if (!length || length > 253) return -1;
  for (const char *p = name; *p; ++p)
    if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') || (*p >= '0' && *p <= '9') || *p == '.' || *p == '-'))
      return -1; // the relay accepts DNS names only, so this lookup "fails" like getaddrinfo
  int slot = 0;
  while (slot < os_name_count && strcmp(os_names[slot], name)) ++slot;
  if (slot == os_name_count) {
    if (os_name_count == OS_NAME_SLOTS) slot = OS_NAME_SLOTS - 1; // reuse the last slot
    else ++os_name_count;
    memcpy(os_names[slot], name, length + 1);
  }
  address->host = 0xF0u | (enet_uint32)(slot + 1) << 24;
  return 0;
}

int enet_address_get_host_ip(const ENetAddress *address, char *name, size_t nameLength) {
  enet_uint32 h = address->host;
  int n = snprintf(name, nameLength, "%u.%u.%u.%u", h & 255, (h >> 8) & 255, (h >> 16) & 255, h >> 24);
  return n < 0 || (size_t)n >= nameLength ? -1 : 0;
}

int enet_address_get_host(const ENetAddress *address, char *name, size_t nameLength) {
  if (os_is_name_placeholder(address->host)) {
    const char *stored = os_names[(address->host >> 24) - 1];
    if (strlen(stored) >= nameLength) return -1;
    strcpy(name, stored);
    return 0;
  }
  return enet_address_get_host_ip(address, name, nameLength);
}

// One relay connection per ENet socket, keyed by its remote endpoint.
#define OS_SOCKETS 16
static ENetAddress os_socket_remote[OS_SOCKETS + 1];
static int os_socket_used[OS_SOCKETS + 1];

// Received datagrams: a single-producer/single-consumer ring in shared wasm memory per socket.
// The main thread (browser.js, WebSocket onmessage) writes slots and advances `head`; ENet on the
// client pthread reads them here without any call to the main thread. A synchronous proxied call
// per datagram (the previous design) took ~10 ms each, which limited a map download to a few
// KB/s and left "Loading snapshot" stuck. Layout (read by browser.js): u32 head, u32 tail,
// u32 dropped, then OS_RX_SLOTS x {u32 length, u8 data[ENET_PROTOCOL_MAXIMUM_MTU]}.
#define OS_RX_SLOTS 512
typedef struct {
  _Atomic enet_uint32 head, tail;
  enet_uint32 dropped;
  struct { enet_uint32 length; unsigned char data[ENET_PROTOCOL_MAXIMUM_MTU]; } slots[OS_RX_SLOTS];
} OsRxRing;
static OsRxRing *os_rx[OS_SOCKETS + 1];

ENetSocket enet_socket_create(ENetSocketType type) {
  (void)type;
  for (int i = 1; i <= OS_SOCKETS; ++i) {
    if (os_socket_used[i]) continue;
    OsRxRing *ring = calloc(1, sizeof(OsRxRing));
    if (!ring) return ENET_SOCKET_NULL;
    os_socket_used[i] = 1; os_rx[i] = ring;
    MAIN_THREAD_EM_ASM({ if (Module['osNetOpen']) Module['osNetOpen']($0, $1, $2, $3); },
                       i, ring, OS_RX_SLOTS, ENET_PROTOCOL_MAXIMUM_MTU);
    return i;
  }
  return ENET_SOCKET_NULL;
}

// The relay sockets themselves are in browser.js (Module.osNetOpen/osNetSend/osNetClose) on the
// main thread. Closing is synchronous so the ring is no longer written once it is freed.
void enet_socket_destroy(ENetSocket socket) {
  if (socket < 1 || socket > OS_SOCKETS || !os_socket_used[socket]) return;
  os_socket_used[socket] = 0;
  MAIN_THREAD_EM_ASM({ if (Module['osNetClose']) Module['osNetClose']($0); }, socket);
  free(os_rx[socket]); os_rx[socket] = NULL;
}

int enet_socket_send(ENetSocket socket, const ENetAddress *address, const ENetBuffer *buffers, size_t count) {
  size_t length = 0;
  if (!address || socket < 1 || socket > OS_SOCKETS) return -1;
  for (size_t i = 0; i < count; ++i) length += buffers[i].dataLength;
  if (length > ENET_PROTOCOL_MAXIMUM_MTU) return -1;
  os_socket_remote[socket] = *address;
  char host[256];
  if (enet_address_get_host(address, host, sizeof(host)) != 0) return -1;
  // Fire-and-forget to the main thread (like sendto on UDP); browser.js frees the copy. Proxied
  // calls run in order, so datagrams keep their order and a later close comes after them.
  size_t hostLength = strlen(host) + 1;
  unsigned char *copy = malloc(hostLength + length);
  if (!copy) return -1;
  memcpy(copy, host, hostLength);
  size_t offset = hostLength;
  for (size_t i = 0; i < count; ++i) {
    memcpy(copy + offset, buffers[i].data, buffers[i].dataLength);
    offset += buffers[i].dataLength;
  }
  // A datagram is accepted even if the relay is still connecting or has failed (see browser.js);
  // ENet's retransmission and timeouts then behave as with UDP to an unreachable server.
  MAIN_THREAD_ASYNC_EM_ASM({
    try {
      if (Module['osNetSend'])
        Module['osNetSend']($0, UTF8ToString($1), $2, HEAPU8.slice($1 + $3, $1 + $3 + $4));
    } finally { _free($1); }
  }, socket, copy, address->port, (int)hostLength, (int)length);
  return (int)length;
}

int enet_socket_receive(ENetSocket socket, ENetAddress *address, ENetBuffer *buffers, size_t count) {
  if (count != 1 || socket < 1 || socket > OS_SOCKETS || !os_rx[socket]) return -1;
  OsRxRing *ring = os_rx[socket];
  for (;;) {
    enet_uint32 tail = atomic_load_explicit(&ring->tail, memory_order_relaxed);
    if (tail == atomic_load_explicit(&ring->head, memory_order_acquire)) return 0;
    const enet_uint32 slot = tail % OS_RX_SLOTS, length = ring->slots[slot].length;
    const int fits = length <= buffers[0].dataLength;
    if (fits) memcpy(buffers[0].data, ring->slots[slot].data, length);
    atomic_store_explicit(&ring->tail, tail + 1, memory_order_release);
    if (!fits) continue; // ENet discards oversized datagrams either way
    if (address) *address = os_socket_remote[socket];
    return (int)length;
  }
}
