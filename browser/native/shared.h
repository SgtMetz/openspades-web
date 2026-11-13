// State shared by the offline host (bridge.cpp) and multiplayer client (net.cpp). GPL-3.0-or-later.
#pragma once
#include <Client/World.h>
#include <Client/Player.h>
#include <Client/Weapon.h>
#include <Client/Grenade.h>
#include <Client/GameMap.h>
#include <Client/GameProperties.h>
#include <Client/IWorldListener.h>
#include <memory>
#include <string>

namespace osweb {
using namespace spades;
using namespace spades::client;

enum EventType {
  EvFire = 1, EvBlockHit = 2, EvTracer = 3, EvExplosion = 4, EvPlayerHit = 5, EvFootstep = 6,
  EvDryFire = 7, EvReload = 8, EvMiss = 9, EvKill = 10, EvBlocksFell = 11, EvBuild = 12,
  EvHurt = 13, EvBuildError = 14, EvThrow = 15, EvRestock = 16,
  EvJump = 17, EvLand = 18, EvReloadDone = 19, EvWater = 20
};

extern std::unique_ptr<World> world;
extern Handle<GameMap> terrain;
extern bool online;
/** Region rendered by the browser, in voxel coordinates [x0, x1) x [y0, y1). */
extern int boundsX0, boundsY0, boundsX1, boundsY1;

void event(int type, int id, Vector3 p = {}, Vector3 q = {});
/** Installs a new terrain, marking every render chunk dirty. */
void attachTerrain(Handle<GameMap> map);
/** Destroys the world and terrain. */
void detachWorld();
Player *localPlayer();
/** Decodes the browser's movement bit field (sprint=64, sneak=128). */
PlayerInput decodeInput(int bits);
} // namespace osweb
