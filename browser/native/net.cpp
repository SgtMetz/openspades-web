// Ace of Spades 0.75/0.76 multiplayer client for the browser port. GPL-3.0-or-later.
// Packet layouts and handling follow OpenSpades' Client/NetClient.cpp and Client_Update.cpp.
// Datagrams travel through ENet (enet_browser.c) and a WebSocket-to-UDP relay.
#include "shared.h"
#include <Client/PhysicsConstants.h>
#include <Core/CP437.h>
#include <emscripten.h>
#include <enet/enet.h>
#include <zlib.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <stdexcept>
#include <vector>

extern "C" ENetAddress os_relay_address;
using namespace osweb;

namespace {
enum PacketType {
  PositionData = 0, OrientationData = 1, WorldUpdate = 2, InputData = 3, WeaponInputPacket = 4,
  HitPacket = 5, SetHP = 5, GrenadePacket = 6, SetTool = 7, SetColour = 8, ExistingPlayer = 9,
  ShortPlayerData = 10, MoveObject = 11, CreatePlayer = 12, BlockAction = 13, BlockLine = 14,
  StateData = 15, KillAction = 16, ChatMessage = 17, MapStart = 18, MapChunk = 19, PlayerLeft = 20,
  TerritoryCapture = 21, ProgressBar = 22, IntelCapture = 23, IntelPickup = 24, IntelDrop = 25,
  Restock = 26, FogColour = 27, WeaponReload = 28, ChangeTeam = 29, ChangeWeapon = 30,
  MapCached = 31, HandShakeInit = 31, HandShakeReturn = 32, VersionGet = 33, VersionSend = 34,
  ExtensionInfo = 60
};
enum Status { Idle = 0, Connecting = 1, ReceivingMap = 2, InGame = 3, Disconnected = 4 };
enum { BLUE_FLAG = 0, GREEN_FLAG = 1, BLUE_BASE = 2, GREEN_BASE = 3 };
constexpr int VersionMajor = 0, VersionMinor = 1, VersionRevision = 5;
const char UtfSign = -1;

std::string encodeString(const std::string &str) {
  auto cp = CP437::Encode(str, -1);
  if (cp.find(char(-1)) != std::string::npos) return std::string(1, UtfSign) + str;
  return cp;
}
std::string decodeString(const std::string &s) {
  if (!s.empty() && s[0] == UtfSign) return s.substr(1);
  return CP437::Decode(s);
}

struct Reader {
  std::vector<char> data;
  size_t pos = 1;
  explicit Reader(std::vector<char> d) : data(std::move(d)) {}
  int type() const { return (unsigned char)data[0]; }
  void need(size_t n) { if (pos + n > data.size()) throw std::runtime_error("Received packet truncated"); }
  uint8_t byte() { need(1); return (uint8_t)data[pos++]; }
  uint32_t u32() {
    need(4);
    uint32_t v = 0;
    for (int i = 0; i < 4; i++) v |= uint32_t((uint8_t)data[pos++]) << (8 * i);
    return v;
  }
  float f32() { uint32_t v = u32(); float f; std::memcpy(&f, &v, 4); return f; }
  Vector3 vec() { float x = f32(), y = f32(), z = f32(); return MakeVector3(x, y, z); }
  IntVector3 color() { IntVector3 c; c.z = byte(); c.y = byte(); c.x = byte(); return c; }
  size_t remaining() const { return data.size() - pos; }
  std::string raw(size_t n) { need(n); std::string s(data.data() + pos, n); pos += n; return s; }
  std::string str(size_t n) { return decodeString(raw(n).c_str()); }
  std::string rest() { return decodeString(raw(remaining()).c_str()); }
};

struct Writer {
  std::vector<char> data;
  explicit Writer(int type) { data.push_back(char(type)); }
  Writer &u8(uint8_t v) { data.push_back(char(v)); return *this; }
  Writer &u32(uint32_t v) { for (int i = 0; i < 4; i++) data.push_back(char(v >> (8 * i))); return *this; }
  Writer &f32(float f) { uint32_t v; std::memcpy(&v, &f, 4); return u32(v); }
  Writer &vec(Vector3 v) { return f32(v.x).f32(v.y).f32(v.z); }
  Writer &color(IntVector3 c) { return u8(c.z).u8(c.y).u8(c.x); }
  Writer &str(const std::string &s) { data.insert(data.end(), s.begin(), s.end()); return *this; }
  Writer &fixed(const std::string &s, size_t n) {
    auto e = encodeString(s).substr(0, n);
    str(e);
    for (size_t i = e.size(); i < n; i++) u8(0);
    return *this;
  }
};

ENetHost *host = nullptr;
ENetPeer *peer = nullptr;
int status = Idle, protocolVersion = 3, disconnectReason = -1, worldGeneration = 0;
std::shared_ptr<GameProperties> properties;
std::vector<unsigned char> mapCompressed;
std::vector<std::vector<char>> savedPackets;
std::array<Vector3, 128> savedPos;
std::array<int, 128> savedTeam;
IntVector3 temporaryBlockColor{112, 112, 112};
unsigned lastInputBits = ~0u, lastWeaponBits = ~0u;
Vector3 lastFront;
float lastPositionSent = -10;
std::string messages, textBuffer;
std::array<float, 64> info;

// Game mode objective state (0 = CTF, 1 = TC), mirrored from CTFGameMode / TCGameMode.
struct Territory { Vector3 pos; int owner = 255, capturing = -1; float progress = 0, rate = 0, startTime = 0; };
int modeType = 0, captureLimit = 10;
int score[2] = {0, 0}, carrier[2] = {-1, -1};
bool hasIntel[2] = {false, false};
Vector3 flagPos[2], basePos[2];
std::vector<Territory> territories;

void message(char kind, const std::string &a, const std::string &b = {}, const std::string &c = {}) {
  if (messages.size() > 65536) return;
  messages += kind; messages += '\x1f'; messages += a; messages += '\x1f'; messages += b;
  messages += '\x1f'; messages += c; messages += '\x1e';
}
void send(const Writer &w, bool reliable = true) {
  if (!peer) return;
  enet_peer_send(peer, 0, enet_packet_create(w.data.data(), w.data.size(), reliable ? ENET_PACKET_FLAG_RELIABLE : 0));
}
std::string disconnectText(unsigned reason) {
  switch (reason) {
    case 1: return "You are banned from this server.";
    case 2: case 10: return "You were kicked from this server.";
    case 3: return "Incompatible client protocol version.";
    case 4: return "Server full.";
    default: return "Connection closed by the server.";
  }
}
Player *playerOrNull(int id) {
  if (!world || id < 0 || id >= int(world->GetNumPlayerSlots())) return nullptr;
  auto p = world->GetPlayer(id);
  return p ? &p.value() : nullptr;
}
Player &player(int id) {
  if (!world) throw std::runtime_error("No world");
  Player *p = playerOrNull(id);
  if (!p) throw std::runtime_error("Invalid player ID " + std::to_string(id));
  return *p;
}
WeaponType weaponType(int w) {
  if (w < 0 || w > 2) throw std::runtime_error("Invalid weapon " + std::to_string(w));
  return WeaponType(w);
}
Player::ToolType toolType(int t) {
  if (t < 0 || t > 3) throw std::runtime_error("Invalid tool " + std::to_string(t));
  return Player::ToolType(t);
}
std::string playerName(int id) { return world && id >= 0 && id < int(world->GetNumPlayerSlots()) ? world->GetPlayerPersistent(id).name : std::string(); }

void sendHeldBlockColor() {
  Player *p = localPlayer();
  if (p) send(Writer(SetColour).u8(p->GetId()).color(p->GetBlockColor()));
}
void sendTool() {
  Player *p = localPlayer();
  if (p) send(Writer(SetTool).u8(p->GetId()).u8(p->GetTool()));
}

/** Network-mode world listener: local actions are reported to the server, which is authoritative. */
struct OnlineListener : IWorldListener {
  bool isLocal(Player &p) { return &p == localPlayer(); }
  void PlayerObjectSet(int) override {}
  void PlayerMadeFootstep(Player &p) override { event(EvFootstep, p.GetId(), p.GetEye(), MakeVector3(p.GetWade(), p.GetInput().sprint, 0)); }
  void PlayerJumped(Player &p) override { event(EvJump, p.GetId(), p.GetEye(), MakeVector3(p.GetWade(), 0, 0)); }
  void PlayerLanded(Player &p, bool hurt) override { event(EvLand, p.GetId(), p.GetEye(), MakeVector3(p.GetWade(), hurt, 0)); }
  void PlayerFiredWeapon(Player &p) override { event(EvFire, p.GetId(), p.GetEye(), MakeVector3(p.GetWeaponType(), 0, 0)); }
  void PlayerDryFiredWeapon(Player &p) override { event(EvDryFire, p.GetId()); }
  void PlayerReloadingWeapon(Player &p) override { event(EvReload, p.GetId(), p.GetEye(), MakeVector3(p.GetWeaponType(), 0, 0)); }
  void PlayerReloadedWeapon(Player &p) override { event(EvReloadDone, p.GetId(), p.GetEye(), MakeVector3(p.GetWeaponType(), 0, 0)); }
  void PlayerChangedTool(Player &) override {}
  void PlayerThrewGrenade(Player &p, stmp::optional<const Grenade &> g) override {
    event(EvThrow, p.GetId(), p.GetEye());
    if (g && isLocal(p)) send(Writer(GrenadePacket).u8(p.GetId()).f32(g->GetFuse()).vec(g->GetPosition()).vec(g->GetVelocity()));
  }
  void PlayerMissedSpade(Player &p) override { event(EvMiss, p.GetId(), p.GetEye()); }
  void PlayerHitBlockWithSpade(Player &, Vector3 hit, IntVector3, IntVector3) override { event(EvBlockHit, 0, hit); }
  void PlayerKilledPlayer(Player &by, Player &p, KillType type) override { event(EvKill, p.GetId(), p.GetEye(), MakeVector3(by.GetId(), type, 0)); }
  void PlayerRestocked(Player &p) override { event(EvRestock, p.GetId()); }
  void BulletHitPlayer(Player &p, HitType type, Vector3 pos, Player &by, std::unique_ptr<IBulletHitScanState> &) override {
    if (!isLocal(by)) return;
    int code = type == HitTypeTorso ? 0 : type == HitTypeHead ? 1 : type == HitTypeArms ? 2 : type == HitTypeLegs ? 3 : 4;
    send(Writer(HitPacket).u8(p.GetId()).u8(code));
    // Damage is decided by the server; this only drives the local hit marker.
    event(EvPlayerHit, by.GetId(), pos, MakeVector3(p.GetId(), -1, type == HitTypeHead ? 1 : 0));
  }
  void BulletHitBlock(Vector3 pos, IntVector3, IntVector3) override { event(EvBlockHit, 0, pos); }
  void AddBulletTracer(Player &p, Vector3 a, Vector3 b) override { event(EvTracer, p.GetId(), a, b); }
  void GrenadeExploded(const Grenade &g) override { event(EvExplosion, 0, g.GetPosition()); }
  void GrenadeBounced(const Grenade &g) override { event(EvMiss, -1, g.GetPosition()); }
  void GrenadeDroppedIntoWater(const Grenade &g) override { event(EvWater, -1, g.GetPosition()); }
  void BlocksFell(std::vector<IntVector3> blocks) override {
    if (!blocks.empty()) event(EvBlocksFell, 0, MakeVector3(blocks[0].x, blocks[0].y, blocks[0].z), MakeVector3(blocks.size(), 0, 0));
  }
  void LocalPlayerPulledGrenadePin() override { event(EvMiss, -1); }
  void LocalPlayerBlockAction(IntVector3 v, BlockActionType type) override {
    Player *p = localPlayer();
    if (!p) return;
    int code = type == BlockActionCreate ? 0 : type == BlockActionTool ? 1 : type == BlockActionDig ? 2 : 3;
    send(Writer(BlockAction).u8(p->GetId()).u8(code).u32(v.x).u32(v.y).u32(v.z));
  }
  void LocalPlayerCreatedLineBlock(IntVector3 a, IntVector3 b) override {
    Player *p = localPlayer();
    if (p) send(Writer(BlockLine).u8(p->GetId()).u32(a.x).u32(a.y).u32(a.z).u32(b.x).u32(b.y).u32(b.z));
  }
  void LocalPlayerHurt(HurtType, bool, Vector3 p) override { event(EvHurt, 0, p); }
  void LocalPlayerBuildError(BuildFailureReason) override { event(EvBuildError, 0); }
} onlineListener;

/** Inflates the zlib map stream and decodes VXL exactly like GameMap::Load. */
Handle<GameMap> parseVxl(const std::vector<unsigned char> &vxl);
Handle<GameMap> decodeMap() {
  std::vector<unsigned char> vxl;
  z_stream zs{};
  if (inflateInit(&zs) != Z_OK) throw std::runtime_error("zlib init failed");
  zs.next_in = mapCompressed.data();
  zs.avail_in = unsigned(mapCompressed.size());
  unsigned char out[65536];
  int rc;
  do {
    zs.next_out = out; zs.avail_out = sizeof(out);
    rc = inflate(&zs, Z_NO_FLUSH);
    if (rc != Z_OK && rc != Z_STREAM_END) { inflateEnd(&zs); throw std::runtime_error("Map data is corrupted"); }
    vxl.insert(vxl.end(), out, out + (sizeof(out) - zs.avail_out));
  } while (rc != Z_STREAM_END && zs.avail_in > 0);
  inflateEnd(&zs);
  return parseVxl(vxl);
}
Handle<GameMap> parseVxl(const std::vector<unsigned char> &vxl) {
  auto map = Handle<GameMap>::New();
  size_t pos = 0;
  auto s8 = [&](size_t at) -> int {
    if (at >= vxl.size()) throw std::runtime_error("Map file truncated");
    return (int8_t)vxl[at];
  };
  auto color = [&](size_t at) -> uint32_t {
    if (at + 4 > vxl.size()) throw std::runtime_error("Map file truncated");
    uint32_t c = vxl[at + 2] | (vxl[at + 1] << 8) | (vxl[at] << 16);
    return c | (100u << 24);
  };
  for (int y = 0; y < 512; y++)
    for (int x = 0; x < 512; x++) {
      for (int z = 0; z < 64; z++) map->Set(x, y, z, true, 0, true);
      int z = 0;
      for (;;) {
        int chunks = s8(pos), topStart = s8(pos + 1), topEnd = s8(pos + 2);
        for (int i = z; i < topStart; i++) map->Set(x, y, i, false, 0, true);
        size_t colorOffset = pos + 4;
        for (z = topStart; z <= topEnd; z++) { map->Set(x, y, z, true, color(colorOffset), true); colorOffset += 4; }
        if (topEnd == 62) map->Set(x, y, 63, true, map->GetColor(x, y, 62), true);
        int lenBottom = topEnd - topStart + 1;
        if (chunks == 0) { pos += 4 * (lenBottom + 1); break; }
        int lenTop = (chunks - 1) - lenBottom;
        pos += size_t(s8(pos)) * 4;
        int bottomEnd = s8(pos + 3), bottomStart = bottomEnd - lenTop;
        for (z = bottomStart; z < bottomEnd; z++) { map->Set(x, y, z, true, color(colorOffset), true); colorOffset += 4; }
        if (bottomEnd == 63) map->Set(x, y, 63, true, map->GetColor(x, y, 62), true);
      }
    }
  return map;
}

void handleGamePacket(Reader &r);

void mapLoaded() {
  auto map = decodeMap();
  mapCompressed.clear();
  mapCompressed.shrink_to_fit();
  detachWorld();
  attachTerrain(map);
  world = std::make_unique<World>(properties);
  world->SetMap(terrain);
  world->SetListener(&onlineListener);
  savedTeam.fill(-1);
  ++worldGeneration;
  auto pending = std::move(savedPackets);
  savedPackets.clear();
  for (auto &d : pending) {
    Reader r(d);
    try { handleGamePacket(r); } catch (const std::exception &e) { printf("Saved packet %d ignored: %s\n", r.type(), e.what()); }
  }
}

void handleStateData(Reader &r) {
  int pId = r.byte();
  IntVector3 fog = r.color(), c0 = r.color(), c1 = r.color();
  std::string n0 = r.str(10), n1 = r.str(10);
  world->GetTeam(0).color = c0; world->GetTeam(1).color = c1;
  world->GetTeam(0).name = n0; world->GetTeam(1).name = n1;
  world->SetFogColor(fog);
  world->SetLocalPlayerIndex(pId);
  modeType = r.byte();
  territories.clear();
  if (modeType == 0) {
    score[0] = r.byte(); score[1] = r.byte(); captureLimit = r.byte();
    int flags = r.byte();
    hasIntel[0] = flags & 1; hasIntel[1] = flags & 2;
    carrier[0] = carrier[1] = -1;
    if (hasIntel[1]) { carrier[0] = r.byte(); r.raw(11); } else flagPos[0] = r.vec();
    if (hasIntel[0]) { carrier[1] = r.byte(); r.raw(11); } else flagPos[1] = r.vec();
    basePos[0] = r.vec(); basePos[1] = r.vec();
  } else {
    int n = r.byte();
    for (int i = 0; i < n; i++) { Territory t; t.pos = r.vec(); t.owner = r.byte(); territories.push_back(t); }
  }
  message('J', n0, n1);
}

void handleGamePacket(Reader &r) {
  switch (r.type()) {
    case PositionData: {
      Player *p = localPlayer();
      if (!p || r.data.size() < 13) break; // Some servers send a 4-byte placeholder.
      p->SetPosition(r.vec());
    } break;
    case OrientationData: { Player *p = localPlayer(); if (p) p->SetOrientation(r.vec()); } break;
    case WorldUpdate: {
      int bytesPerEntry = protocolVersion == 4 ? 25 : 24;
      int entries = int((r.data.size() - 1) / bytesPerEntry);
      for (int i = 0; i < entries; i++) {
        int idx = protocolVersion == 4 ? r.byte() : i;
        Vector3 pos = r.vec(), front = r.vec();
        if (idx < 0 || idx >= 128) continue;
        savedPos[idx] = pos;
        if (!world || (pos.x == 0 && pos.y == 0 && pos.z == 0 && front.x == 0 && front.y == 0 && front.z == 0)) continue;
        if (!std::isfinite(pos.x + pos.y + pos.z + front.x + front.y + front.z) || front.GetLength() > 40) continue;
        Player *p = playerOrNull(idx);
        if (p && p != localPlayer()) { p->SetPosition(pos); p->SetOrientation(front); }
      }
    } break;
    case InputData: {
      if (!world) break;
      Player &p = player(r.byte());
      int bits = r.byte();
      PlayerInput in;
      in.moveForward = bits & 1; in.moveBackward = bits & 2; in.moveLeft = bits & 4; in.moveRight = bits & 8;
      in.jump = bits & 16; in.crouch = bits & 32; in.sneak = bits & 64; in.sprint = bits & 128;
      if (&p == localPlayer()) { if (in.jump) p.ForceJump(); break; }
      p.SetInput(in);
    } break;
    case WeaponInputPacket: {
      if (!world) break;
      Player &p = player(r.byte());
      int bits = r.byte();
      if (&p == localPlayer()) break;
      WeaponInput in; in.primary = bits & 1; in.secondary = bits & 2;
      p.SetWeaponInput(in);
    } break;
    case SetHP: {
      Player *p = localPlayer();
      if (!p) break;
      int hp = r.byte(), type = r.byte();
      Vector3 source = r.vec();
      p->SetHP(hp, type ? HurtTypeWeapon : HurtTypeFall, source);
    } break;
    case GrenadePacket: {
      if (!world) break;
      r.byte();
      float fuse = r.f32();
      Vector3 pos = r.vec(), vel = r.vec();
      world->AddGrenade(std::make_unique<Grenade>(*world, pos, vel, fuse));
    } break;
    case SetTool: { Player &p = player(r.byte()); p.SetTool(toolType(r.byte())); } break;
    case SetColour: {
      Player *p = playerOrNull(r.byte());
      IntVector3 c = r.color();
      if (p) p->SetHeldBlockColor(c); else temporaryBlockColor = c;
    } break;
    case ExistingPlayer: {
      if (!world) break;
      int id = r.byte(), team = r.byte(), weapon = r.byte(), tool = r.byte();
      int kills = r.u32();
      IntVector3 c = r.color();
      std::string name = r.rest();
      if (id < 0 || id >= int(world->GetNumPlayerSlots())) break;
      auto p = std::make_unique<Player>(*world, id, weaponType(weapon), team, savedPos[id], world->GetTeam(team).color);
      p->SetHeldBlockColor(c);
      p->SetTool(toolType(tool));
      world->SetPlayer(id, std::move(p));
      world->GetPlayerPersistent(id).name = name;
      world->GetPlayerPersistent(id).kills = kills;
      savedTeam[id] = team;
    } break;
    case ShortPlayerData: break;
    case MoveObject: {
      int type = r.byte(), state = r.byte();
      Vector3 pos = r.vec();
      if (modeType == 0) {
        if (type == BLUE_BASE) basePos[0] = pos; else if (type == BLUE_FLAG) flagPos[0] = pos;
        else if (type == GREEN_BASE) basePos[1] = pos; else if (type == GREEN_FLAG) flagPos[1] = pos;
      } else if (type < int(territories.size())) {
        territories[type].pos = pos;
        territories[type].owner = state;
      }
    } break;
    case CreatePlayer: {
      if (!world) throw std::runtime_error("No world");
      int id = r.byte(), weapon = r.byte(), team = r.byte();
      Vector3 pos = r.vec();
      pos.z -= 2.f;
      std::string name = r.rest();
      if (id < 0 || id >= int(world->GetNumPlayerSlots())) break;
      auto p = std::make_unique<Player>(*world, id, weaponType(weapon), team, savedPos[id], world->GetTeam(team).color);
      p->SetPosition(pos);
      world->SetPlayer(id, std::move(p));
      if (!name.empty()) world->GetPlayerPersistent(id).name = name;
      if (world->GetLocalPlayerIndex() && *world->GetLocalPlayerIndex() == id) {
        lastInputBits = lastWeaponBits = ~0u;
        lastPositionSent = -10;
        sendHeldBlockColor();
        message('S', name);
      } else if (savedTeam[id] != team) {
        message('T', playerName(id), team < 2 ? world->GetTeam(team).name : "Spectator", std::to_string(team));
      }
      savedTeam[id] = team;
    } break;
    case BlockAction: {
      if (!world) break;
      Player *p = playerOrNull(r.byte());
      int action = r.byte();
      IntVector3 pos;
      pos.x = int(r.u32()); pos.y = int(r.u32()); pos.z = int(r.u32());
      std::vector<IntVector3> cells;
      if (action == 0) {
        bool replace = terrain->IsSolidWrapped(pos.x, pos.y, pos.z);
        world->CreateBlock(pos, p ? p->GetBlockColor() : temporaryBlockColor);
        event(EvBuild, p ? p->GetId() : -1, MakeVector3(pos.x + .5f, pos.y + .5f, pos.z + .5f));
        if (p && !replace) p->UsedBlocks(1);
      } else if (action == 1) {
        cells.push_back(pos);
        world->DestroyBlock(cells);
        event(EvBlockHit, 0, MakeVector3(pos.x + .5f, pos.y + .5f, pos.z + .5f));
        if (p && p->GetTool() == Player::ToolSpade) p->GotBlock();
      } else if (action == 2) {
        for (int z = -1; z <= 1; z++) cells.push_back(IntVector3::Make(pos.x, pos.y, pos.z + z));
        world->DestroyBlock(cells);
        event(EvBlockHit, 0, MakeVector3(pos.x + .5f, pos.y + .5f, pos.z + .5f));
      } else if (action == 3) {
        for (int x = -1; x <= 1; x++)
          for (int y = -1; y <= 1; y++)
            for (int z = -1; z <= 1; z++) cells.push_back(IntVector3::Make(pos.x + x, pos.y + y, pos.z + z));
        world->DestroyBlock(cells);
      }
    } break;
    case BlockLine: {
      if (!world) break;
      Player *p = playerOrNull(r.byte());
      IntVector3 a, b;
      a.x = int(r.u32()); a.y = int(r.u32()); a.z = int(r.u32());
      b.x = int(r.u32()); b.y = int(r.u32()); b.z = int(r.u32());
      IntVector3 c = p ? p->GetBlockColor() : temporaryBlockColor;
      auto cells = world->CubeLine(a, b, 50);
      for (auto &v : cells)
        if (v.x >= 0 && v.y >= 0 && v.z >= 0 && v.x < 512 && v.y < 512 && v.z < 64 && !terrain->IsSolid(v.x, v.y, v.z))
          world->CreateBlock(v, c);
      if (p) {
        p->UsedBlocks(int(cells.size()));
        event(EvBuild, p->GetId(), p->GetEye());
      }
    } break;
    case StateData: if (world) handleStateData(r); break;
    case KillAction: {
      Player &victim = player(r.byte());
      int killerId = r.byte();
      Player *killer = playerOrNull(killerId);
      int kt = r.byte();
      if (kt < 0 || kt > 6) throw std::runtime_error("Invalid kill type");
      KillType type = KillType(kt);
      int respawn = r.byte();
      if (!killer || type == KillTypeFall || type == KillTypeClassChange || type == KillTypeTeamChange) killer = &victim;
      victim.KilledBy(type, *killer, respawn);
      if (killer != &victim) world->GetPlayerPersistent(killer->GetId()).kills += 1;
      message('K', playerName(killer->GetId()), playerName(victim.GetId()), std::to_string(kt) + "," + std::to_string(killer->GetTeamId()) + "," + std::to_string(victim.GetTeamId()) + "," + std::to_string(int(killer->GetWeaponType())) + "," + std::to_string(killer->GetId()) + "," + std::to_string(victim.GetId()));
    } break;
    case ChatMessage: {
      int id = r.byte(), type = r.byte();
      std::string text = r.rest();
      Player *p = playerOrNull(id);
      if (p && type <= 1) message(type == 0 ? 'C' : 'G', p->GetName(), text, std::to_string(p->GetTeamId()));
      else {
        message('M', text);
        if (properties) properties->HandleServerMessage(text);
      }
    } break;
    case MapStart: {
      if (protocolVersion == 4) send(Writer(MapCached).u8(0));
      detachWorld();
      mapCompressed.clear();
      savedPackets.clear();
      status = ReceivingMap;
      message('L', std::to_string(r.u32()));
    } break;
    case MapChunk: throw std::runtime_error("Unexpected map chunk");
    case PlayerLeft: {
      Player &p = player(r.byte());
      message('Q', p.GetName());
      world->GetPlayerPersistent(p.GetId()).kills = 0;
      savedTeam[p.GetId()] = -1;
      world->SetPlayer(p.GetId(), nullptr);
    } break;
    case TerritoryCapture: {
      int id = r.byte();
      bool winning = r.byte() != 0;
      int state = r.byte();
      if (modeType != 1 || id >= int(territories.size())) break;
      auto &t = territories[id];
      t.owner = state; t.progress = t.rate = t.startTime = 0; t.capturing = -1;
      if (state < 2) message('A', world->GetTeam(state).name, std::to_string(id), std::to_string(state));
      if (winning && state < 2) message('W', world->GetTeam(state).name, std::to_string(state));
    } break;
    case ProgressBar: {
      int id = r.byte(), team = r.byte(), rate = (int8_t)r.byte();
      float progress = r.f32();
      if (modeType != 1 || id >= int(territories.size())) break;
      auto &t = territories[id];
      t.progress = progress; t.rate = rate * TC_CAPTURE_RATE; t.startTime = world->GetTime(); t.capturing = team;
    } break;
    case IntelCapture: {
      Player &p = player(r.byte());
      bool winning = r.byte() != 0;
      int team = p.GetTeamId();
      world->GetPlayerPersistent(p.GetId()).kills += 10;
      if (team < 2) { hasIntel[team] = false; carrier[team] = -1; score[team]++; }
      message('I', p.GetName(), "captured", std::to_string(team));
      if (winning && team < 2) {
        score[0] = score[1] = 0; hasIntel[0] = hasIntel[1] = false;
        message('W', world->GetTeam(team).name, std::to_string(team));
      }
    } break;
    case IntelPickup: {
      Player &p = player(r.byte());
      int team = p.GetTeamId();
      if (team < 2) { hasIntel[team] = true; carrier[team] = p.GetId(); }
      message('I', p.GetName(), "picked up", std::to_string(team));
    } break;
    case IntelDrop: {
      Player &p = player(r.byte());
      int team = p.GetTeamId();
      Vector3 pos = r.vec();
      if (team < 2) { hasIntel[team] = false; carrier[team] = -1; flagPos[1 - team] = pos; }
      message('I', p.GetName(), "dropped", std::to_string(team));
    } break;
    case Restock: { Player *p = localPlayer(); if (p) p->Restock(); } break;
    case FogColour: if (world) { r.byte(); world->SetFogColor(r.color()); } break;
    case WeaponReload: {
      Player &p = player(r.byte());
      if (&p != localPlayer()) p.Reload();
      else {
        int clip = r.byte(), reserve = r.byte();
        if (clip < 255 && reserve < 255) p.ReloadDone(clip, reserve);
      }
    } break;
    case ChangeTeam: {
      Player &p = player(r.byte());
      int team = r.byte();
      if (team > 2 && team != 255) throw std::runtime_error("Invalid team");
      p.SetTeam(team);
    } break;
    case ChangeWeapon: break;
    default: printf("Dropped packet type %d\n", r.type());
  }
}

bool handleHandshake(Reader &r) {
  switch (r.type()) {
    case HandShakeInit: send(Writer(HandShakeReturn).u32(r.u32())); return true;
    case ExtensionInfo: send(Writer(ExtensionInfo).u8(0)); return true; // No extensions are implemented.
    case VersionGet: {
      if (r.remaining() == 0) {
        send(Writer(VersionSend).u8('o').u8(VersionMajor).u8(VersionMinor).u8(VersionRevision).str("OpenSpades 0.1.5 Browser Edition (WebAssembly)"));
        return true;
      }
      std::vector<uint8_t> ids;
      while (r.remaining()) ids.push_back(r.byte());
      std::sort(ids.begin(), ids.end());
      ids.erase(std::unique(ids.begin(), ids.end()), ids.end());
      for (auto id : ids) {
        Writer w(ExistingPlayer);
        w.u8('x').u8(id).u8(0);
        size_t lengthAt = w.data.size() - 1, begin = w.data.size();
        if (id == 0) w.u8(VersionMajor).u8(VersionMinor).u8(VersionRevision).str("OpenSpades");
        else if (id == 1) w.str("en_US");
        else if (id == 2) w.u32(1); // Supports UTF-8 strings.
        w.data[lengthAt] = char(w.data.size() - begin);
        send(w);
      }
      return true;
    }
    default: return false;
  }
}

void processPacket(std::vector<char> data) {
  if (data.empty()) return;
  Reader r(std::move(data));
  if (handleHandshake(r)) return;
  if (status == Connecting) {
    if (r.type() != MapStart) { printf("Unexpected packet %d before map\n", r.type()); return; }
    mapCompressed.clear();
    status = ReceivingMap;
    message('L', std::to_string(r.u32()));
  } else if (status == ReceivingMap) {
    if (r.type() == MapChunk) {
      mapCompressed.insert(mapCompressed.end(), r.data.begin() + 1, r.data.end());
    } else if (r.type() == StateData) {
      mapLoaded();
      status = InGame;
      handleGamePacket(r);
    } else if (r.type() != WeaponReload) {
      // Drop leftover reloads from the previous round; keep world updates for the new one.
      savedPackets.push_back(r.data);
    }
  } else if (status == InGame) {
    handleGamePacket(r);
  }
}

void closeConnection(int reason, const std::string &text) {
  if (peer) enet_peer_reset(peer);
  peer = nullptr;
  if (host) enet_host_destroy(host);
  host = nullptr;
  status = Disconnected;
  disconnectReason = reason;
  detachWorld();
  online = true;
  message('D', text);
}
} // namespace

extern "C" {
void os_net_disconnect();
/** Loads a raw .vxl (the main menu's Maps/Title.vxl) as terrain only, with no game world. */
EMSCRIPTEN_KEEPALIVE int os_load_vxl(const unsigned char *data, int length) {
  if (peer) os_net_disconnect();
  detachWorld();
  online = true;
  boundsX0 = boundsY0 = 0; boundsX1 = boundsY1 = 512;
  try { attachTerrain(parseVxl(std::vector<unsigned char>(data, data + length))); } catch (const std::exception &e) { printf("Title map: %s\n", e.what()); return -1; }
  status = Idle;
  return 0;
}
/** Starts an ENet connection through Module.osNet; version is 3 (AoS 0.75) or 4 (AoS 0.76). */
EMSCRIPTEN_KEEPALIVE int os_net_connect(int version) {
  if (peer) enet_peer_reset(peer);
  if (host) enet_host_destroy(host);
  peer = nullptr;
  detachWorld();
  online = true;
  boundsX0 = boundsY0 = 0; boundsX1 = boundsY1 = 512;
  protocolVersion = version == 4 ? 4 : 3;
  properties = std::make_shared<GameProperties>(protocolVersion == 4 ? ProtocolVersion::v076 : ProtocolVersion::v075);
  savedPackets.clear(); mapCompressed.clear(); messages.clear();
  savedPos.fill(Vector3()); savedTeam.fill(-1);
  disconnectReason = -1;
  host = enet_host_create(nullptr, 1, 1, 0, 0);
  if (!host || enet_host_compress_with_range_coder(host) < 0) { status = Disconnected; return -1; }
  peer = enet_host_connect(host, &os_relay_address, 1, protocolVersion);
  if (!peer) { status = Disconnected; return -1; }
  status = Connecting;
  return 0;
}
/** Processes all received datagrams and sends queued packets. Returns the connection status. */
EMSCRIPTEN_KEEPALIVE int os_net_poll() {
  if (!host) return status;
  ENetEvent ev;
  int guard = 0;
  while (host && guard++ < 4096) {
    int rc = enet_host_service(host, &ev, 0);
    if (rc <= 0) { if (rc < 0) closeConnection(-1, "Network error."); break; }
    if (ev.type == ENET_EVENT_TYPE_DISCONNECT) {
      closeConnection(int(ev.data), status == Connecting ? "Could not reach the server." : disconnectText(ev.data));
      break;
    }
    if (ev.type != ENET_EVENT_TYPE_RECEIVE) continue;
    std::vector<char> data(ev.packet->data, ev.packet->data + ev.packet->dataLength);
    enet_packet_destroy(ev.packet);
    int type = data.empty() ? -1 : (unsigned char)data[0];
    try {
      processPacket(std::move(data));
    } catch (const std::exception &e) {
      printf("Packet %d ignored: %s\n", type, e.what());
      if (status == ReceivingMap || (status == InGame && !world)) {
        // A map that cannot be decoded is fatal, as in the desktop client.
        enet_peer_disconnect_now(peer, 0);
        closeConnection(-1, std::string("Could not load the map: ") + e.what());
      }
    }
  }
  if (host) enet_host_flush(host);
  return status;
}
EMSCRIPTEN_KEEPALIVE void os_net_disconnect() {
  if (peer) {
    enet_peer_disconnect_now(peer, 0);
    enet_host_flush(host);
  }
  closeConnection(0, "Disconnected.");
  messages.clear();
  status = Idle;
}
/** status, map bytes, ping, local id, mode, score0, score1, capture limit, intel/carrier and objective positions. */
EMSCRIPTEN_KEEPALIVE float *os_net_info() {
  info.fill(0);
  info[0] = status; info[1] = float(mapCompressed.size()); info[2] = peer ? float(peer->roundTripTime) : -1;
  info[3] = world && world->GetLocalPlayerIndex() ? float(*world->GetLocalPlayerIndex()) : -1;
  info[4] = modeType; info[5] = score[0]; info[6] = score[1]; info[7] = captureLimit;
  info[8] = hasIntel[0]; info[9] = hasIntel[1]; info[10] = carrier[0]; info[11] = carrier[1];
  Vector3 v[4] = {flagPos[0], flagPos[1], basePos[0], basePos[1]};
  for (int i = 0; i < 4; i++) { info[12 + i * 3] = v[i].x; info[13 + i * 3] = v[i].y; info[14 + i * 3] = v[i].z; }
  info[24] = float(territories.size()); info[25] = disconnectReason; info[26] = float(worldGeneration);
  info[27] = protocolVersion;
  return info.data();
}
/** Six floats per territory: x, y, z, owner, capturing team, progress (0..1). */
EMSCRIPTEN_KEEPALIVE float *os_net_territories() {
  static std::vector<float> out;
  out.clear();
  for (auto &t : territories) {
    float progress = t.progress;
    if (world && t.capturing >= 0) progress = std::clamp(t.progress + t.rate * (world->GetTime() - t.startTime), 0.f, 1.f);
    out.insert(out.end(), {t.pos.x, t.pos.y, t.pos.z, float(t.owner), float(t.capturing), progress});
  }
  return out.data();
}
/** Records separated by 0x1e, fields by 0x1f: kind, a, b, c. Cleared by os_net_clear_messages. */
EMSCRIPTEN_KEEPALIVE const char *os_net_messages() { textBuffer = messages; return textBuffer.c_str(); }
EMSCRIPTEN_KEEPALIVE void os_net_clear_messages() { messages.clear(); }
/** Joins as team 0, 1 or 255 (spectator). */
EMSCRIPTEN_KEEPALIVE void os_net_join(int team, int weapon, const char *name) {
  if (!world || status != InGame) return;
  if (team != 0 && team != 1) { team = 255; weapon = 0; }
  IntVector3 c = team < 2 ? world->GetTeam(team).color : IntVector3(0, 0, 0);
  send(Writer(ExistingPlayer).u8(0).u8(team).u8(std::clamp(weapon, 0, 2)).u8(2).u32(0).color(c).fixed(name, 16));
}
EMSCRIPTEN_KEEPALIVE void os_net_change_team(int team) {
  Player *p = localPlayer();
  if (p) send(Writer(ChangeTeam).u8(p->GetId()).u8(team == 0 || team == 1 ? team : 255));
}
EMSCRIPTEN_KEEPALIVE void os_net_change_weapon(int weapon) {
  Player *p = localPlayer();
  if (p) send(Writer(ChangeWeapon).u8(p->GetId()).u8(std::clamp(weapon, 0, 2)));
}
EMSCRIPTEN_KEEPALIVE void os_net_chat(const char *text, int global) {
  Player *p = localPlayer();
  if (!p || !text || !*text) return;
  send(Writer(ChatMessage).u8(p->GetId()).u8(global ? 0 : 1).str(encodeString(text)).u8(0));
}
/** Same arguments as os_input; mirrors Client::UpdateLocalPlayer. */
EMSCRIPTEN_KEEPALIVE void os_net_input(int bits, int buttons, float yaw, float pitch, int tool) {
  Player *lp = localPlayer();
  if (!lp || !lp->IsAlive() || lp->GetTeamId() >= 2) return;
  Player &p = *lp;
  p.SetOrientation(MakeVector3(cos(yaw) * cos(pitch), sin(yaw) * cos(pitch), sin(pitch)));
  PlayerInput in = decodeInput(bits);
  Vector3 vel = p.GetVelocity();
  if (std::hypot(vel.x, vel.y) < .1f) in.sprint = false;
  if (in.jump && !p.IsOnGroundOrWade()) in.jump = false;
  WeaponInput w; w.primary = buttons & 1; w.secondary = buttons & 2;
  if (in.sprint) w.primary = w.secondary = false;
  if (p.GetTool() == Player::ToolWeapon) {
    if (p.IsAwaitingReloadCompletion() && !p.GetWeapon().IsReloadSlow()) w.primary = w.secondary = false;
    if (p.GetWeapon().GetAmmo() == 0) w.primary = false;
  }
  if (tool >= 0 && tool <= 3 && tool != int(p.GetTool()) && p.IsToolSelectable(Player::ToolType(tool))) {
    p.SetTool(Player::ToolType(tool));
    sendTool();
  }
  if (!p.IsToolSelectable(p.GetTool())) {
    w.primary = w.secondary = false;
    Player::ToolType t = p.GetTool();
    for (int i = 0; i < 4 && !p.IsToolSelectable(t); i++)
      t = t == Player::ToolSpade ? Player::ToolGrenade : t == Player::ToolBlock ? Player::ToolSpade : t == Player::ToolWeapon ? Player::ToolBlock : Player::ToolWeapon;
    p.SetTool(t);
    sendTool();
  }
  p.SetInput(in);
  p.SetWeaponInput(w);
  in = p.GetInput(); // Uncrouching may be refused by an obstacle.
  unsigned inputBits = in.moveForward | in.moveBackward << 1 | in.moveLeft << 2 | in.moveRight << 3 | in.jump << 4 | in.crouch << 5 | in.sneak << 6 | in.sprint << 7;
  if (inputBits != lastInputBits) { lastInputBits = inputBits; send(Writer(InputData).u8(p.GetId()).u8(inputBits)); }
  unsigned weaponBits = w.primary | w.secondary << 1;
  if (weaponBits != lastWeaponBits) { lastWeaponBits = weaponBits; send(Writer(WeaponInputPacket).u8(p.GetId()).u8(weaponBits)); }
}
EMSCRIPTEN_KEEPALIVE void os_net_step(float dt) {
  if (!world || status != InGame) return;
  world->Advance(std::clamp(dt, 0.f, 1.f / 30));
  Player *p = localPlayer();
  if (!p || p->GetTeamId() >= 2 || !p->IsAlive()) return;
  Vector3 front = p->GetFront();
  if (front.x != lastFront.x || front.y != lastFront.y || front.z != lastFront.z) {
    lastFront = front;
    send(Writer(OrientationData).vec(front));
  }
  if (world->GetTime() > lastPositionSent + 1.f) {
    lastPositionSent = world->GetTime();
    send(Writer(PositionData).vec(p->GetPosition()));
  }
}
EMSCRIPTEN_KEEPALIVE void os_net_reload() {
  Player *p = localPlayer();
  if (!p || !p->IsAlive() || p->GetTool() != Player::ToolWeapon) return;
  auto &w = p->GetWeapon();
  if (w.GetAmmo() >= w.GetClipSize() || w.GetStock() <= 0 || p->IsAwaitingReloadCompletion() || w.IsReloading()) return;
  p->Reload();
  send(Writer(WeaponReload).u8(p->GetId()).u8(255).u8(255));
}
EMSCRIPTEN_KEEPALIVE void os_net_color(int c) {
  Player *p = localPlayer();
  if (!p) return;
  p->SetHeldBlockColor(IntVector3(c & 255, (c >> 8) & 255, (c >> 16) & 255));
  sendHeldBlockColor();
}
}
