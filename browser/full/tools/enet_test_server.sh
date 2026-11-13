#!/bin/bash
# Builds and runs tools/enet_test_server.c natively (WSL) from the upstream ENet sources.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
enet="$here/../../../openspades/Sources/ENet"
bin="$here/../build/enet_test_server"
if [ ! -x "$bin" ] || [ "$here/enet_test_server.c" -nt "$bin" ]; then
  gcc -O1 -DHAS_SOCKLEN_T -I"$enet/include" "$here/enet_test_server.c" \
    "$enet"/callbacks.c "$enet"/compress.c "$enet"/host.c "$enet"/list.c "$enet"/packet.c \
    "$enet"/peer.c "$enet"/protocol.c "$enet"/unix.c -o "$bin"
fi
exec "$bin" "$@"
