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
#include <emscripten/em_asm.h>

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

ENetSocket enet_socket_create(ENetSocketType type) {
  (void)type;
  for (int i = 1; i <= OS_SOCKETS; ++i)
    if (!os_socket_used[i]) { os_socket_used[i] = 1; return i; }
  return ENET_SOCKET_NULL;
}

// The relay sockets themselves are in browser.js (Module.osNetSend/osNetReceive/osNetClose),
// called synchronously on the main thread.
void enet_socket_destroy(ENetSocket socket) {
  if (socket < 1 || socket > OS_SOCKETS) return;
  os_socket_used[socket] = 0;
  MAIN_THREAD_EM_ASM({ if (Module['osNetClose']) Module['osNetClose']($0); }, socket);
}

int enet_socket_send(ENetSocket socket, const ENetAddress *address, const ENetBuffer *buffers, size_t count) {
  unsigned char packet[ENET_PROTOCOL_MAXIMUM_MTU];
  size_t length = 0;
  if (!address || socket < 1 || socket > OS_SOCKETS) return -1;
  for (size_t i = 0; i < count; ++i) {
    if (length + buffers[i].dataLength > sizeof(packet)) return -1;
    memcpy(packet + length, buffers[i].data, buffers[i].dataLength);
    length += buffers[i].dataLength;
  }
  os_socket_remote[socket] = *address;
  char host[256];
  if (enet_address_get_host(address, host, sizeof(host)) != 0) return -1;
  // A datagram is accepted even if the relay is still connecting or has failed (see browser.js);
  // ENet's retransmission and timeouts then behave as with UDP to an unreachable server.
  MAIN_THREAD_EM_ASM({
    if (Module['osNetSend']) Module['osNetSend']($0, UTF8ToString($1), $2, HEAPU8.slice($3, $3 + $4));
  }, socket, host, address->port, packet, (int)length);
  return (int)length;
}

int enet_socket_receive(ENetSocket socket, ENetAddress *address, ENetBuffer *buffers, size_t count) {
  if (count != 1 || socket < 1 || socket > OS_SOCKETS) return -1;
  int length = MAIN_THREAD_EM_ASM_INT({
    return Module['osNetReceive'] ? Module['osNetReceive']($0, $1, $2) : 0;
  }, socket, buffers[0].data, (int)buffers[0].dataLength);
  if (length > 0 && address) *address = os_socket_remote[socket];
  return length;
}
