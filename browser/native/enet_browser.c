// ENet platform layer for browsers. GPL-3.0-or-later (ENet itself is MIT).
// Browsers cannot open UDP sockets, so every ENet datagram is carried as one
// binary WebSocket message to a relay (server.mjs) that forwards it over UDP.
// JavaScript owns the WebSocket and exposes it as Module.osNet:
//   send(Uint8Array) -> bytes accepted, queue: Uint8Array[] of received datagrams.
#define ENET_BUILDING_LIB 1
#include <string.h>
#include <emscripten.h>
#include "enet/enet.h"

EM_JS(int, os_js_udp_send, (const unsigned char *data, int length), {
  const net = Module['osNet'];
  if (!net) return -1;
  return net.send(HEAPU8.slice(data, data + length));
});

EM_JS(int, os_js_udp_receive, (unsigned char *data, int capacity), {
  const net = Module['osNet'];
  if (!net || !net.queue.length) return 0;
  const packet = net.queue.shift();
  if (packet.length > capacity) return -1;
  HEAPU8.set(packet, data);
  return packet.length;
});

// The relay has exactly one remote endpoint, so ENet only needs a stable
// address for the peer; the real server address is given to the relay.
ENetAddress os_relay_address = {0x0100007f, 1};
static enet_uint32 timeBase = 0;

int enet_initialize(void) { return 0; }
void enet_deinitialize(void) {}
enet_uint32 enet_host_random_seed(void) { return (enet_uint32)(emscripten_random() * 4294967295.0); }
enet_uint32 enet_time_get(void) { return (enet_uint32)emscripten_get_now() - timeBase; }
void enet_time_set(enet_uint32 newTimeBase) { timeBase = (enet_uint32)emscripten_get_now() - newTimeBase; }

int enet_address_set_host_ip(ENetAddress *address, const char *name) { (void)address; (void)name; return -1; }
int enet_address_set_host(ENetAddress *address, const char *name) { (void)address; (void)name; return -1; }
int enet_address_get_host_ip(const ENetAddress *address, char *name, size_t nameLength) { (void)address; (void)name; (void)nameLength; return -1; }
int enet_address_get_host(const ENetAddress *address, char *name, size_t nameLength) { (void)address; (void)name; (void)nameLength; return -1; }

ENetSocket enet_socket_create(ENetSocketType type) { (void)type; return 1; }
int enet_socket_bind(ENetSocket socket, const ENetAddress *address) { (void)socket; (void)address; return 0; }
int enet_socket_get_address(ENetSocket socket, ENetAddress *address) { (void)socket; address->host = 0; address->port = 0; return 0; }
int enet_socket_listen(ENetSocket socket, int backlog) { (void)socket; (void)backlog; return -1; }
int enet_socket_set_option(ENetSocket socket, ENetSocketOption option, int value) { (void)socket; (void)option; (void)value; return 0; }
int enet_socket_get_option(ENetSocket socket, ENetSocketOption option, int *value) { (void)socket; (void)option; *value = 0; return 0; }
int enet_socket_connect(ENetSocket socket, const ENetAddress *address) { (void)socket; (void)address; return 0; }
ENetSocket enet_socket_accept(ENetSocket socket, ENetAddress *address) { (void)socket; (void)address; return ENET_SOCKET_NULL; }
int enet_socket_shutdown(ENetSocket socket, ENetSocketShutdown how) { (void)socket; (void)how; return 0; }
void enet_socket_destroy(ENetSocket socket) { (void)socket; }

int enet_socket_send(ENetSocket socket, const ENetAddress *address, const ENetBuffer *buffers, size_t bufferCount) {
  (void)socket; (void)address;
  unsigned char datagram[4096];
  size_t length = 0;
  for (size_t i = 0; i < bufferCount; i++) {
    if (length + buffers[i].dataLength > sizeof(datagram)) return -1;
    memcpy(datagram + length, buffers[i].data, buffers[i].dataLength);
    length += buffers[i].dataLength;
  }
  int sent = os_js_udp_send(datagram, (int)length);
  return sent < 0 ? -1 : (int)length;
}

int enet_socket_receive(ENetSocket socket, ENetAddress *address, ENetBuffer *buffers, size_t bufferCount) {
  (void)socket;
  if (bufferCount != 1) return -1;
  int length = os_js_udp_receive((unsigned char *)buffers[0].data, (int)buffers[0].dataLength);
  if (length > 0 && address) *address = os_relay_address;
  return length;
}

int enet_socketset_select(ENetSocket maxSocket, ENetSocketSet *readSet, ENetSocketSet *writeSet, enet_uint32 timeout) {
  (void)maxSocket; (void)readSet; (void)writeSet; (void)timeout; return 0;
}

int enet_socket_wait(ENetSocket socket, enet_uint32 *condition, enet_uint32 timeout) {
  (void)socket; (void)timeout;
  *condition = ENET_SOCKET_WAIT_NONE;
  return 0;
}
