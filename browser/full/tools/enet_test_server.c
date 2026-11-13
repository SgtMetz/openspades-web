// Local ENet endpoint for the automated network check (tools/headless-check.mjs net).
// Built natively from the upstream ENet sources; not an Ace of Spades server. It accepts one
// connection with the same range-coder compression as AoS servers, sends one reliable packet,
// then disconnects the client with reason 4 ("Server full"), which exercises datagrams in both
// directions through the browser relay and NetClient's disconnect handling.
#include <enet/enet.h>
#include <stdio.h>
#include <stdlib.h>

int main(int argc, char **argv) {
  if (enet_initialize()) return 2;
  ENetAddress address = {ENET_HOST_ANY, (enet_uint16)(argc > 1 ? atoi(argv[1]) : 32999)};
  ENetHost *host = enet_host_create(&address, 4, 1, 0, 0);
  if (!host) { fprintf(stderr, "bind failed\n"); return 2; }
  enet_host_compress_with_range_coder(host);
  printf("LISTENING %u\n", address.port); fflush(stdout);
  ENetPeer *client = NULL;
  enet_uint32 connectedAt = 0, deadline = enet_time_get() + 120000;
  int connections = 0;
  while (enet_time_get() < deadline) {
    ENetEvent event;
    while (enet_host_service(host, &event, 50) > 0) {
      if (event.type == ENET_EVENT_TYPE_CONNECT) {
        char ip[64]; enet_address_get_host_ip(&event.peer->address, ip, sizeof ip);
        printf("CONNECT version=%u from %s\n", event.data, ip); fflush(stdout);
        client = event.peer; connectedAt = enet_time_get(); ++connections;
        ENetPacket *packet = enet_packet_create("osweb-test", 10, ENET_PACKET_FLAG_RELIABLE);
        enet_peer_send(client, 0, packet);
      } else if (event.type == ENET_EVENT_TYPE_RECEIVE) {
        printf("RECEIVE %u bytes\n", (unsigned)event.packet->dataLength); fflush(stdout);
        enet_packet_destroy(event.packet);
      } else if (event.type == ENET_EVENT_TYPE_DISCONNECT) {
        printf("DISCONNECT\n"); fflush(stdout);
        client = NULL;
        if (connections >= 1) { enet_host_destroy(host); return 0; }
      }
    }
    if (client && connectedAt && enet_time_get() - connectedAt > 1500) {
      enet_peer_disconnect(client, 4);
      connectedAt = 0;
    }
  }
  printf("TIMEOUT\n");
  enet_host_destroy(host);
  return 1;
}
