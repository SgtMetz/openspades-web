// Offline host, shared rendering exports and C ABI for the original OpenSpades simulation.
// GPL-3.0-or-later.
#include "shared.h"
#include <Core/IStream.h>
#include <emscripten.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <vector>

namespace osweb {
std::unique_ptr<World> world;
Handle<GameMap> terrain;
bool online = false;
int boundsX0 = 192, boundsY0 = 192, boundsX1 = 320, boundsY1 = 320;
}

using namespace osweb;
namespace {
constexpr int ChunkSize = 16, ChunksPerSide = 512 / ChunkSize, MaxSlots = 128;
std::vector<float> events;
std::vector<unsigned char> meshPos, meshColor;
std::vector<signed char> meshNormal;
std::vector<unsigned> meshIndex;
std::vector<float> grenadeData;
std::vector<unsigned> topMap;
std::array<float, MaxSlots * 16> players;
std::array<float, 32> stats;
std::array<float, MaxSlots * 8> skinStates;
struct MapOutput : IStream {
  std::vector<unsigned char> bytes;
  void Write(const void *data, size_t n) override {
    auto begin = static_cast<const unsigned char *>(data);
    bytes.insert(bytes.end(), begin, begin + n);
  }
} mapOutput;
std::array<unsigned char, ChunksPerSide * ChunksPerSide> dirty;
std::string nameBuffer;
int kills = 0, deaths = 0, botCount = 6, selectedWeapon = 0, roundWon = 0;
unsigned revision = 0;

int surface(int x, int y) {
  for (int z = 0; z < 64; z++)
    if (terrain->IsSolid(x, y, z)) return z;
  return 63;
}
bool solidAt(int x, int y, int z) {
  return x >= 0 && x < 512 && y >= 0 && y < 512 && z >= 0 && z < 64 && terrain->IsSolid(x, y, z);
}
Player &local() { return *localPlayer(); }
bool valid(IntVector3 p) { return p.x >= 192 && p.x < 320 && p.y >= 192 && p.y < 320 && p.z >= 0 && p.z < 62; }

struct MapListener : IGameMapListener {
  void GameMapChanged(int x, int y, int, GameMap *) override {
    ++revision;
    for (int dx = -1; dx <= 1; dx++)
      for (int dy = -1; dy <= 1; dy++) {
        int cx = x + dx, cy = y + dy;
        if (cx >= 0 && cy >= 0 && cx < 512 && cy < 512) dirty[(cy / ChunkSize) * ChunksPerSide + cx / ChunkSize] = 1;
      }
  }
} mapListener;

void damage(Player &victim, Player &by, int amount, KillType type) {
  if (!victim.IsAlive() || roundWon) return;
  int hp = std::max(0, victim.GetHealth() - amount);
  if (hp == 0) {
    victim.KilledBy(type, by, 4);
    if (by.GetId() == 0 && victim.GetId() != 0) { ++kills; if (kills >= 15) roundWon = 1; }
    if (victim.GetId() == 0) ++deaths;
  } else victim.SetHP(hp, HurtTypeWeapon, by.GetEye());
  event(EvPlayerHit, by.GetId(), victim.GetEye(), MakeVector3(victim.GetId(), hp, type == KillTypeHeadshot ? 1 : 0));
}

/** Local authoritative host used by the offline practice match. */
struct OfflineListener : IWorldListener {
  void PlayerObjectSet(int) override {}
  void PlayerMadeFootstep(Player &p) override { event(EvFootstep, p.GetId(), p.GetEye(), MakeVector3(p.GetWade(), p.GetInput().sprint, 0)); }
  void PlayerJumped(Player &p) override { event(EvJump, p.GetId(), p.GetEye(), MakeVector3(p.GetWade(), 0, 0)); }
  void PlayerLanded(Player &p, bool hurt) override { event(EvLand, p.GetId(), p.GetEye(), MakeVector3(p.GetWade(), hurt, 0)); }
  void PlayerFiredWeapon(Player &p) override { event(EvFire, p.GetId(), p.GetEye(), MakeVector3(p.GetWeaponType(), 0, 0)); }
  void PlayerDryFiredWeapon(Player &p) override { event(EvDryFire, p.GetId()); }
  void PlayerReloadingWeapon(Player &p) override { event(EvReload, p.GetId(), p.GetEye(), MakeVector3(p.GetWeaponType(), 0, 0)); }
  void PlayerReloadedWeapon(Player &p) override {
    event(EvReloadDone, p.GetId(), p.GetEye(), MakeVector3(p.GetWeaponType(), 0, 0));
    if (p.IsLocalPlayer()) {
      auto &w = p.GetWeapon();
      if (!w.IsReloadSlow()) w.ForceReloadDone();
      p.ReloadDone(w.GetAmmo(), w.GetStock());
    }
  }
  void PlayerChangedTool(Player &) override {}
  void PlayerThrewGrenade(Player &p, stmp::optional<const Grenade &>) override { event(EvThrow, p.GetId(), p.GetEye()); }
  void PlayerMissedSpade(Player &p) override { event(EvMiss, p.GetId(), p.GetEye()); }
  void PlayerHitBlockWithSpade(Player &, Vector3 hit, IntVector3, IntVector3) override { event(EvBlockHit, 0, hit); }
  void PlayerKilledPlayer(Player &by, Player &p, KillType type) override { event(EvKill, p.GetId(), p.GetEye(), MakeVector3(by.GetId(), type, 0)); }
  void PlayerRestocked(Player &p) override { event(EvRestock, p.GetId(), p.GetEye()); }
  void BulletHitPlayer(Player &p, HitType type, Vector3, Player &by, std::unique_ptr<IBulletHitScanState> &) override {
    if (p.GetTeamId() == by.GetTeamId()) return;
    int amount = type == HitTypeMelee ? 100 : by.GetWeapon().GetDamage(type, (p.GetEye() - by.GetEye()).GetLength());
    // Practice opponents have deliberately forgiving damage; the local weapon is unmodified.
    if (by.GetId() != 0) amount = std::max(5, amount / 3);
    damage(p, by, amount, type == HitTypeHead ? KillTypeHeadshot : KillTypeWeapon);
  }
  void BulletHitBlock(Vector3 pos, IntVector3, IntVector3) override { event(EvBlockHit, 0, pos); }
  void AddBulletTracer(Player &p, Vector3 a, Vector3 b) override { event(EvTracer, p.GetId(), a, b); }
  void GrenadeExploded(const Grenade &g) override {
    auto p = g.GetPosition();
    event(EvExplosion, 0, p);
    std::vector<IntVector3> blocks;
    auto center = p.Floor();
    for (int x = -2; x <= 2; x++)
      for (int y = -2; y <= 2; y++)
        for (int z = -2; z <= 2; z++) {
          auto v = center + IntVector3(x, y, z);
          if (x * x + y * y + z * z <= 6 && valid(v)) blocks.push_back(v);
        }
    world->DestroyBlock(blocks);
    for (int i = 0; i <= botCount; i++) {
      auto &v = *world->GetPlayer(i);
      float d = (v.GetEye() - p).GetLength();
      auto ray = terrain->CastRay2(p, (v.GetEye() - p).Normalize(), 64);
      if (d < 12 && (!ray.hit || (ray.hitPos - p).GetLength() + .5f >= d))
        damage(v, local(), int(180.f / (1 + d * .4f)), KillTypeGrenade);
    }
  }
  void GrenadeBounced(const Grenade &g) override { event(EvMiss, -1, g.GetPosition()); }
  void GrenadeDroppedIntoWater(const Grenade &g) override { event(EvWater, -1, g.GetPosition()); }
  void BlocksFell(std::vector<IntVector3> blocks) override {
    if (!blocks.empty()) event(EvBlocksFell, 0, MakeVector3(blocks[0].x, blocks[0].y, blocks[0].z), MakeVector3(blocks.size(), 0, 0));
  }
  void LocalPlayerPulledGrenadePin() override { event(EvMiss, -1); }
  void LocalPlayerBlockAction(IntVector3 p, BlockActionType type) override {
    if (!valid(p)) return;
    if (type == BlockActionCreate) {
      if (!terrain->IsSolid(p.x, p.y, p.z)) {
        world->CreateBlock(p, local().GetBlockColor());
        local().UsedBlocks(1);
        event(EvBuild, 0, MakeVector3(p.x, p.y, p.z));
      }
    } else {
      std::vector<IntVector3> blocks{p};
      if (type == BlockActionDig) {
        if (valid(p + IntVector3(0, 0, 1))) blocks.push_back(p + IntVector3(0, 0, 1));
        if (valid(p - IntVector3(0, 0, 1))) blocks.push_back(p - IntVector3(0, 0, 1));
      }
      world->DestroyBlock(blocks);
      if (local().GetTool() == Player::ToolSpade) local().GotBlock();
    }
  }
  void LocalPlayerCreatedLineBlock(IntVector3 a, IntVector3 b) override {
    auto line = world->CubeLine(a, b, std::min(50, local().GetNumBlocks()));
    for (auto p : line) LocalPlayerBlockAction(p, BlockActionCreate);
  }
  void LocalPlayerHurt(HurtType, bool, Vector3 p) override { event(EvHurt, 0, p); }
  void LocalPlayerBuildError(BuildFailureReason) override { event(EvBuildError, 0); }
} offlineListener;

uint32_t rgb(int r, int g, int b) { return 0x64000000u | r | (g << 8) | (b << 16); }
void block(int x, int y, int z, uint32_t c) {
  if (x >= 192 && x < 320 && y >= 192 && y < 320 && z >= 0 && z < 63) terrain->Set(x, y, z, true, c, true);
}
void box(int x, int y, int z, int w, int d, int h, uint32_t c) {
  for (int a = x; a < x + w; a++)
    for (int b = y; b < y + d; b++)
      for (int k = z; k < z + h; k++) block(a, b, k, c);
}
Handle<GameMap> generate() {
  terrain = Handle<GameMap>::New();
  for (int x = 0; x < 512; x++)
    for (int y = 0; y < 512; y++) {
      terrain->Set(x, y, 0, false, 0, true);
      terrain->Set(x, y, 63, true, rgb(103, 129, 141), true);
      if (x < 192 || x >= 320 || y < 192 || y >= 320) continue;
      float edge = std::max(std::abs(x - 256), std::abs(y - 256));
      int h = 48 + int(2 * sin(x * .085) * cos(y * .11));
      if (edge > 49) h = std::min(63, h + int((edge - 49) * 1.3));
      if (std::abs(y - 256) < 8 && x > 242 && x < 270) h = 55; // river cutting
      if ((x < 241 && x > 215 && std::abs(y - 256) < 12) || (x > 272 && x < 296 && std::abs(y - 256) < 12)) h = 48;
      for (int z = h; z < 63; z++) {
        int n = ((x * 17 + y * 31 + z * 7) % 13) - 6;
        auto c = z == h ? (h > 55 ? rgb(172 + n, 163 + n, 122 + n) : rgb(100 + n, 126 + n, 68 + n)) : rgb(101 + n, 91 + n, 68 + n);
        block(x, y, z, c);
      }
    }
  // A bridge, defensive walls, two bunkers and scattered trees, all editable voxels.
  box(240, 253, 47, 34, 6, 2, rgb(139, 125, 95));
  for (int x = 244; x < 274; x += 7) { box(x, 253, 45, 1, 1, 2, rgb(125, 112, 87)); box(x, 258, 45, 1, 1, 2, rgb(125, 112, 87)); }
  for (int side = 0; side < 2; side++) {
    int x = side ? 286 : 216;
    box(x, 241, 42, 9, 1, 6, rgb(130, 139, 131)); box(x, 241, 42, 1, 10, 6, rgb(130, 139, 131));
    box(x + 8, 241, 42, 1, 10, 6, rgb(130, 139, 131)); box(x, 241, 41, 9, 10, 1, rgb(116, 125, 117));
    box(x + 2, 244, 40, 5, 4, 1, side ? rgb(62, 108, 167) : rgb(98, 139, 73));
    box(side ? 276 : 233, 264, 46, 2, 9, 2, rgb(150, 139, 109));
    box(side ? 281 : 228, 248, 46, 2, 4, 2, rgb(150, 139, 109));
  }
  for (int i = 0; i < 38; i++) {
    int x = 201 + (i * 37) % 108, y = 201 + (i * 53) % 108;
    if (std::abs(y - 256) < 16) continue;
    int z = surface(x, y);
    if (z > 55) continue;
    box(x, y, z - 8, 1, 1, 8, rgb(99, 79, 53));
    box(x - 2, y - 2, z - 10, 5, 5, 4, rgb(61, 93, 56));
    box(x - 1, y - 1, z - 12, 3, 3, 3, rgb(75, 111, 62));
  }
  return terrain;
}
void spawn(int id) {
  int x = id ? 280 + (id % 3) * 4 : 226, y = id ? 250 + (id / 3) * 5 + (id % 3) * 2 : 256;
  auto p = std::make_unique<Player>(*world, id, WeaponType(id ? 0 : selectedWeapon), id ? 1 : 0, MakeVector3(x + .5f, y + .5f, surface(x, y) - 2.4f), IntVector3(100, 140, 70));
  p->SetPosition(p->GetPosition());
  world->SetPlayer(id, std::move(p));
  world->GetPlayerPersistent(id).name = id ? "Blue " + std::to_string(id) : "You";
}
} // namespace

namespace osweb {
void event(int type, int id, Vector3 p, Vector3 q) {
  if (events.size() > 8192) return;
  events.insert(events.end(), {float(type), float(id), p.x, p.y, p.z, q.x, q.y, q.z});
}
void attachTerrain(Handle<GameMap> map) {
  terrain = map;
  terrain->AddListener(&mapListener);
  dirty.fill(1);
  ++revision;
}
void detachWorld() {
  if (terrain) terrain->RemoveListener(&mapListener);
  world.reset();
  terrain = nullptr;
  events.clear();
}
Player *localPlayer() {
  if (!world) return nullptr;
  auto p = world->GetLocalPlayer();
  return p ? &p.value() : nullptr;
}
PlayerInput decodeInput(int bits) {
  PlayerInput in;
  in.moveForward = bits & 1; in.moveBackward = bits & 2; in.moveLeft = bits & 4; in.moveRight = bits & 8;
  in.jump = bits & 16; in.crouch = bits & 32; in.sprint = bits & 64; in.sneak = bits & 128;
  return in;
}
} // namespace osweb

extern "C" {
// ---- Offline practice host ----
EMSCRIPTEN_KEEPALIVE void os_init(int weapon, int bots) {
  detachWorld();
  online = false;
  boundsX0 = boundsY0 = 192; boundsX1 = boundsY1 = 320;
  kills = deaths = roundWon = 0;
  selectedWeapon = std::clamp(weapon, 0, 2);
  botCount = std::clamp(bots, 0, 12);
  attachTerrain(generate());
  world = std::make_unique<World>(std::make_shared<GameProperties>(ProtocolVersion::v075));
  world->SetMap(terrain);
  world->SetLocalPlayerIndex(0);
  world->GetTeam(0).color = IntVector3(95, 142, 67); world->GetTeam(1).color = IntVector3(65, 113, 180);
  world->GetTeam(0).name = "Green"; world->GetTeam(1).name = "Blue";
  world->SetListener(&offlineListener);
  for (int i = 0; i <= botCount; i++) spawn(i);
}
EMSCRIPTEN_KEEPALIVE void os_input(int bits, int buttons, float yaw, float pitch, int tool) {
  if (!world || online || roundWon) return;
  auto &p = local();
  p.SetOrientation(MakeVector3(cos(yaw) * cos(pitch), sin(yaw) * cos(pitch), sin(pitch)));
  p.SetInput(decodeInput(bits));
  if (tool >= 0 && tool <= 3 && p.IsToolSelectable(Player::ToolType(tool))) p.SetTool(Player::ToolType(tool));
  WeaponInput w; w.primary = buttons & 1; w.secondary = buttons & 2;
  p.SetWeaponInput(w);
}
EMSCRIPTEN_KEEPALIVE void os_step(float dt) {
  if (!world || online || roundWon) return;
  dt = std::clamp(dt, 0.f, 1.f / 30);
  float t = world->GetTime();
  for (int i = 0; i <= botCount; i++) {
    auto &p = *world->GetPlayer(i);
    if (!p.IsAlive()) { if (t > p.GetRespawnTime()) spawn(i); continue; }
    if (i == 0) continue;
    Vector3 delta = local().GetEye() - p.GetEye();
    float d = delta.GetLength();
    auto sight = terrain->CastRay2(p.GetEye(), delta.Normalize(), 128);
    bool visible = local().IsAlive() && (!sight.hit || (sight.hitPos - p.GetEye()).GetLength() > d - .5f);
    Vector3 aim = delta;
    aim.x += sin(t * 1.9 + i) * 1.3f; aim.y += cos(t * 1.5 + i) * 1.3f; aim.z += sin(t + i) * .7f;
    p.SetOrientation(aim.Normalize());
    PlayerInput in;
    in.moveForward = d > 20; in.moveLeft = sin(t * .5 + i) > .4; in.moveRight = sin(t * .5 + i) < -.4;
    in.jump = (int(t * 2 + i) % 7 == 0);
    p.SetInput(in);
    WeaponInput w; w.primary = visible && d < 85 && (int(t * 1.5 + i) % 4 == 0);
    p.SetWeaponInput(w);
  }
  world->Advance(dt);
  if (local().IsAlive() && local().GetHealth() <= 0) local().KilledBy(KillTypeFall, local(), 4);
}
EMSCRIPTEN_KEEPALIVE void os_reload() { if (world && !online && local().IsAlive()) local().Reload(); }
EMSCRIPTEN_KEEPALIVE void os_color(int c) { if (world && !online) local().SetHeldBlockColor(IntVector3(c & 255, (c >> 8) & 255, (c >> 16) & 255)); }
EMSCRIPTEN_KEEPALIVE void os_restock() {
  if (world && !online && local().IsAlive() && (local().GetPosition() - MakeVector3(226.5, 256.5, 45.6)).GetLength() < 9) {
    local().Restock();
    local().SetHP(100, HurtTypeWeapon, {});
  }
}

// ---- Shared state queries used by both modes ----
EMSCRIPTEN_KEEPALIVE float *os_state() {
  stats.fill(0);
  stats[29] = -1;
  if (!world) return stats.data();
  stats[16] = world->GetTime();
  stats[20] = float(revision);
  stats[14] = float(kills); stats[15] = float(deaths); stats[19] = float(roundWon);
  Player *lp = localPlayer();
  if (!lp) return stats.data();
  auto &p = *lp;
  auto &w = p.GetWeapon();
  auto eye = p.GetEye(), front = p.GetFront();
  float values[] = {eye.x, eye.y, eye.z, front.x, front.y, front.z, float(p.GetHealth()), float(w.GetAmmo()), float(w.GetStock()),
                    float(p.GetNumBlocks()), float(p.GetNumGrenades()), float(p.GetTool()), float(w.IsReloading()),
                    w.IsReloading() ? w.GetReloadProgress() : 0.f};
  std::copy(std::begin(values), std::end(values), stats.begin());
  if (online) stats[14] = float(world->GetPlayerPersistent(p.GetId()).kills);
  stats[17] = float(p.IsAlive());
  stats[18] = p.IsAlive() ? 0.f : std::max(0.f, p.GetRespawnTime() - world->GetTime());
  stats[21] = float(p.GetWeaponType());
  stats[22] = float(p.IsBlockCursorActive());
  if (p.IsBlockCursorActive()) {
    auto b = p.GetBlockCursorPos();
    stats[23] = b.x; stats[24] = b.y; stats[25] = b.z;
  }
  stats[26] = float(p.IsCookingGrenade());
  stats[27] = p.IsCookingGrenade() ? p.GetGrenadeCookTime() : 0.f;
  stats[28] = 1;
  stats[29] = float(p.GetId());
  stats[30] = float(p.GetTeamId());
  auto c = p.GetBlockColor();
  stats[31] = float(c.x | (c.y << 8) | (c.z << 16));
  return stats.data();
}
EMSCRIPTEN_KEEPALIVE int os_player_slots() {
  if (!world) return 0;
  return online ? std::min<int>(MaxSlots, int(world->GetNumPlayerSlots())) : botCount + 1;
}
/** 16 floats per slot: eye xyz, front xyz, alive, hp, team, crouch, walk, exists, tool, weapon, local, kills. */
EMSCRIPTEN_KEEPALIVE float *os_players() {
  players.fill(0);
  int n = os_player_slots();
  Player *lp = localPlayer();
  for (int i = 0; i < n; i++) {
    auto opt = world->GetPlayer(i);
    if (!opt) continue;
    auto &p = opt.value();
    auto v = p.GetEye(), f = p.GetFront();
    float *b = &players[i * 16];
    b[0] = v.x; b[1] = v.y; b[2] = v.z; b[3] = f.x; b[4] = f.y; b[5] = f.z;
    b[6] = p.IsAlive(); b[7] = p.GetHealth(); b[8] = p.GetTeamId(); b[9] = p.GetInput().crouch;
    b[10] = p.GetWalkAnimationProgress(); b[11] = 1; b[12] = p.GetTool(); b[13] = p.GetWeaponType();
    b[14] = &p == lp; b[15] = float(world->GetPlayerPersistent(i).kills);
  }
  return players.data();
}
/** ClientPlayer::SetSkinParameterForTool, exported without inventing browser animation timers.
 * Eight floats per player: spade action/progress, gun ready, velocity xyz, wading, sprinting. */
EMSCRIPTEN_KEEPALIVE float *os_skin_states() {
  skinStates.fill(0);
  for (int i = 0; i < os_player_slots(); ++i) {
    auto opt = world->GetPlayer(i);
    if (!opt) continue;
    auto &p = opt.value();
    auto in = p.GetWeaponInput();
    float *b = &skinStates[i * 8];
    if (p.GetTool() == Player::ToolSpade) {
      if (in.primary) { b[0] = 1; b[1] = p.GetSpadeAnimationProgress(); }
      else if (in.secondary) { b[0] = p.IsFirstDig() ? 3 : 2; b[1] = p.GetDigAnimationProgress(); }
    }
    auto &w = p.GetWeapon();
    b[2] = 1.f - w.TimeToNextFire() / w.GetDelay();
    auto v = p.GetVelocity();
    b[3] = v.x; b[4] = v.y; b[5] = v.z;
    b[6] = p.GetWade(); b[7] = p.GetInput().sprint;
  }
  return skinStates.data();
}
/** Serializes through the original desktop GameMap::Save implementation. */
EMSCRIPTEN_KEEPALIVE int os_save_vxl() {
  mapOutput.bytes.clear();
  if (!terrain) return 0;
  terrain->Save(&mapOutput);
  return int(mapOutput.bytes.size());
}
EMSCRIPTEN_KEEPALIVE unsigned char *os_saved_vxl() { return mapOutput.bytes.data(); }
EMSCRIPTEN_KEEPALIVE const char *os_player_name(int i) {
  nameBuffer.clear();
  if (world && i >= 0 && i < int(world->GetNumPlayerSlots())) nameBuffer = world->GetPlayerPersistent(i).name;
  return nameBuffer.c_str();
}
EMSCRIPTEN_KEEPALIVE const char *os_team_name(int i) {
  nameBuffer.clear();
  if (world && (i == 0 || i == 1)) nameBuffer = world->GetTeam(i).name;
  return nameBuffer.c_str();
}
EMSCRIPTEN_KEEPALIVE int os_team_color(int i) {
  if (!world || (i != 0 && i != 1)) return 0x808080;
  auto c = world->GetTeam(i).color;
  return c.x | (c.y << 8) | (c.z << 16);
}
EMSCRIPTEN_KEEPALIVE int os_fog_color() {
  if (!world) return 0;
  auto c = world->GetFogColor();
  return c.x | (c.y << 8) | (c.z << 16);
}
EMSCRIPTEN_KEEPALIVE int os_event_count() { return events.size() / 8; }
EMSCRIPTEN_KEEPALIVE float *os_events() { return events.data(); }
EMSCRIPTEN_KEEPALIVE void os_clear_events() { events.clear(); }
/** Rendered region: x0, y0, x1, y1 in voxels. */
EMSCRIPTEN_KEEPALIVE int os_bounds(int i) { return i == 0 ? boundsX0 : i == 1 ? boundsY0 : i == 2 ? boundsX1 : boundsY1; }
/** Chunk index is cy * 32 + cx over the whole 512 x 512 map; chunks are 16 x 16 voxels. */
EMSCRIPTEN_KEEPALIVE int os_dirty(int i) {
  if (i < 0 || i >= int(dirty.size())) return 0;
  int v = dirty[i];
  dirty[i] = 0;
  return v;
}
EMSCRIPTEN_KEEPALIVE int os_solid(int x, int y, int z) { return terrain && solidAt(x, y, z); }
EMSCRIPTEN_KEEPALIVE int os_top(int x, int y) { return terrain ? surface(std::clamp(x, 0, 511), std::clamp(y, 0, 511)) : 63; }
EMSCRIPTEN_KEEPALIVE unsigned os_top_color(int x, int y) { return terrain ? terrain->GetColor(x, y, surface(x, y)) : 0; }
/** Fills a w x h image (RGBA little endian) of the topmost voxel colors starting at (x0, y0). */
EMSCRIPTEN_KEEPALIVE unsigned *os_top_map(int x0, int y0, int w, int h) {
  topMap.assign(size_t(w) * h, 0xff000000u);
  if (!terrain) return topMap.data();
  for (int y = 0; y < h; y++)
    for (int x = 0; x < w; x++) {
      int mx = x0 + x, my = y0 + y;
      if (mx < 0 || my < 0 || mx >= 512 || my >= 512) continue;
      topMap[size_t(y) * w + x] = (terrain->GetColor(mx, my, surface(mx, my)) & 0xffffff) | 0xff000000u;
    }
  return topMap.data();
}
/**
 * Meshes one 16 x 16 column chunk. Output vertices are chunk-relative, in renderer space
 * (x, 64 - z, y) and stored as separate byte arrays: position (u8), normal (i8), color (u8),
 * plus a u32 index buffer. Colors include ambient occlusion.
 */
EMSCRIPTEN_KEEPALIVE int os_mesh(int chunk) {
  meshPos.clear(); meshNormal.clear(); meshColor.clear(); meshIndex.clear();
  if (!terrain || chunk < 0 || chunk >= ChunksPerSide * ChunksPerSide) return 0;
  int x0 = (chunk % ChunksPerSide) * ChunkSize, y0 = (chunk / ChunksPerSide) * ChunkSize;
  static const int ns[6][3] = {{1, 0, 0}, {-1, 0, 0}, {0, 1, 0}, {0, -1, 0}, {0, 0, 1}, {0, 0, -1}};
  // Each face is emitted counterclockwise in native coordinates.
  static const int vs[6][4][3] = {{{1, 0, 0}, {1, 1, 0}, {1, 1, 1}, {1, 0, 1}}, {{0, 1, 0}, {0, 0, 0}, {0, 0, 1}, {0, 1, 1}},
                                  {{1, 1, 0}, {0, 1, 0}, {0, 1, 1}, {1, 1, 1}}, {{0, 0, 0}, {1, 0, 0}, {1, 0, 1}, {0, 0, 1}},
                                  {{0, 0, 1}, {1, 0, 1}, {1, 1, 1}, {0, 1, 1}}, {{0, 1, 0}, {1, 1, 0}, {1, 0, 0}, {0, 0, 0}}};
  static const float aoScale[4] = {.52f, .68f, .84f, 1.f};
  for (int x = x0; x < x0 + ChunkSize; x++)
    for (int y = y0; y < y0 + ChunkSize; y++) {
      uint64_t column = terrain->GetSolidMapWrapped(x, y);
      for (int z = 0; z < 63; z++) {
        if (!((column >> z) & 1)) continue;
        unsigned c = terrain->GetColor(x, y, z);
        for (int f = 0; f < 6; f++) {
          const int *n = ns[f];
          int fx = x + n[0], fy = y + n[1], fz = z + n[2];
          if (solidAt(fx, fy, fz)) continue;
          unsigned base = unsigned(meshPos.size() / 3);
          for (int i = 0; i < 4; i++) {
            const int *v = vs[f][i];
            // Ambient occlusion from the voxels surrounding this corner in front of the face.
            int k = 0, axes[2];
            for (int a = 0; a < 3; a++) if (!n[a]) axes[k++] = a;
            int s1[3] = {fx, fy, fz}, s2[3] = {fx, fy, fz}, cr[3] = {fx, fy, fz};
            int da = v[axes[0]] ? 1 : -1, db = v[axes[1]] ? 1 : -1;
            s1[axes[0]] += da; s2[axes[1]] += db; cr[axes[0]] += da; cr[axes[1]] += db;
            bool a1 = solidAt(s1[0], s1[1], s1[2]), a2 = solidAt(s2[0], s2[1], s2[2]), a3 = solidAt(cr[0], cr[1], cr[2]);
            int ao = (a1 && a2) ? 0 : 3 - (a1 + a2 + a3);
            float shade = aoScale[ao];
            meshPos.insert(meshPos.end(), {(unsigned char)(x - x0 + v[0]), (unsigned char)(64 - z - v[2]), (unsigned char)(y - y0 + v[1])});
            meshNormal.insert(meshNormal.end(), {(signed char)(n[0] * 127), (signed char)(-n[2] * 127), (signed char)(n[1] * 127)});
            meshColor.insert(meshColor.end(), {(unsigned char)((c & 255) * shade), (unsigned char)(((c >> 8) & 255) * shade), (unsigned char)(((c >> 16) & 255) * shade)});
          }
          meshIndex.insert(meshIndex.end(), {base, base + 1, base + 2, base, base + 2, base + 3});
        }
      }
    }
  return int(meshPos.size() / 3);
}
EMSCRIPTEN_KEEPALIVE unsigned char *os_mesh_positions() { return meshPos.data(); }
EMSCRIPTEN_KEEPALIVE signed char *os_mesh_normals() { return meshNormal.data(); }
EMSCRIPTEN_KEEPALIVE unsigned char *os_mesh_colors() { return meshColor.data(); }
EMSCRIPTEN_KEEPALIVE unsigned *os_mesh_indices() { return meshIndex.data(); }
EMSCRIPTEN_KEEPALIVE int os_mesh_index_count() { return int(meshIndex.size()); }
/** Four floats per grenade: position xyz and fuse. */
EMSCRIPTEN_KEEPALIVE int os_grenades() {
  grenadeData.clear();
  if (!world) return 0;
  for (auto &g : world->GetAllGrenades()) {
    auto p = g->GetPosition();
    grenadeData.insert(grenadeData.end(), {p.x, p.y, p.z, g->GetFuse()});
  }
  return grenadeData.size() / 4;
}
EMSCRIPTEN_KEEPALIVE float *os_grenade_data() { return grenadeData.data(); }
}
