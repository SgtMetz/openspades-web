#include "BrowserAudio.h"

#include <Client/GameMap.h>
#include <Core/Debug.h>
#include <Core/FileManager.h>
#include <Core/Settings.h>
#include <emscripten.h>
#include <algorithm>
#include <cmath>

// Same names and defaults as Audio/ALDevice.cpp, so the original startup window and
// preferences configure this device.
DEFINE_SPADES_SETTING(s_maxPolyphonics, "96");
DEFINE_SPADES_SETTING(s_eax, "1");
DEFINE_SPADES_SETTING(s_gain, "1");

namespace spades::audio {
	namespace {
		// Mode passed to the page: 0 = world 3D, 1 = listener-relative 3D, 2 = 2D.
		enum { World = 0, Relative = 1, Flat = 2 };
	}

	BrowserAudio::BrowserAudio() : roomHistory(128, 40.f * 2.f), roomFeedbackHistory(128, 0.f) {
		MAIN_THREAD_EM_ASM({ if (Module['fullAudio']) Module['fullAudio'].reset(); });
	}
	BrowserAudio::~BrowserAudio() { SetGameMap(nullptr); }

	client::IAudioChunk *BrowserAudio::RegisterSound(const char *name) {
		SPADES_MARK_FUNCTION();
		auto it = chunks.find(name);
		if (it != chunks.end()) return it->second.GetPointerOrNull();
		// Throws like the desktop device when the file does not exist.
		std::string bytes = FileManager::ReadAllBytes(name);
		auto chunk = Handle<Chunk>::New(name, nextId++);
		MAIN_THREAD_EM_ASM({
			if (Module['fullAudio']) Module['fullAudio'].load($0, UTF8ToString($1), HEAPU8.slice($2, $2 + $3));
		}, chunk->id, name, bytes.data(), (int)bytes.size());
		chunks.emplace(name, chunk);
		return chunk.GetPointerOrNull();
	}

	void BrowserAudio::ClearCache() {
		chunks.clear();
		MAIN_THREAD_ASYNC_EM_ASM({ if (Module['fullAudio']) Module['fullAudio'].clear(); });
	}

	void BrowserAudio::SetGameMap(client::GameMap *mp) {
		if (mp) mp->AddRef();
		if (map) map->Release();
		map = mp;
	}

	bool BrowserAudio::Obstructed(const Vector3 &pos) {
		// ALSrc::UpdateObstruction: obstructed only if every ray to the 27 points around the
		// source hits the map.
		if (!map || !(int)s_eax) return false;
		for (int x = -1; x <= 1; x++)
			for (int y = -1; y <= 1; y++)
				for (int z = -1; z <= 1; z++) {
					Vector3 check = pos + MakeVector3((float)x, (float)y, (float)z) * .2f;
					IntVector3 hit;
					if (!map->CastRay(eye, (check - eye).Normalize(), (check - eye).GetLength(), hit))
						return false;
				}
		return true;
	}

	void BrowserAudio::play(client::IAudioChunk *c, Vector3 p, const client::AudioParam &a, int mode) {
		auto *chunk = static_cast<Chunk *>(c);
		if (!chunk) return;
		float gain = a.volume * std::max(std::min((float)s_gain, 4.f), 0.f);
		bool obstructed = mode == World && Obstructed(p);
		bool reverb = mode != Flat && (int)s_eax != 0;
		MAIN_THREAD_ASYNC_EM_ASM({
			if (Module['fullAudio'])
				Module['fullAudio'].play($0, $1, $2, $3, [$4, $5, $6], $7, !!$8, !!$9, $10);
		}, chunk->id, gain, a.pitch, a.referenceDistance, p.x, p.y, p.z, mode, obstructed, reverb,
		   (int)s_maxPolyphonics);
	}
	void BrowserAudio::Play(client::IAudioChunk *c, const Vector3 &p, const client::AudioParam &a) {
		play(c, p, a, World);
	}
	void BrowserAudio::PlayLocal(client::IAudioChunk *c, const Vector3 &p, const client::AudioParam &a) {
		play(c, p, a, Relative);
	}
	void BrowserAudio::PlayLocal(client::IAudioChunk *c, const client::AudioParam &a) {
		play(c, MakeVector3(0, 0, 0), a, Flat);
	}

	void BrowserAudio::Respatialize(const Vector3 &e, const Vector3 &f, const Vector3 &u) {
		eye = e;
		front = f;
		up = u;
		MAIN_THREAD_ASYNC_EM_ASM({
			if (Module['fullAudio']) Module['fullAudio'].listener([$0, $1, $2], [$3, $4, $5], [$6, $7, $8]);
		}, e.x, e.y, e.z, f.x, f.y, f.z, u.x, u.y, u.z);
		if ((int)s_eax) UpdateReverb();
	}

	// ALDevice::Internal::Respatialize reverb estimation, unchanged; the resulting EFX
	// parameters drive the page's convolution reverb.
	void BrowserAudio::UpdateReverb() {
		const float maxDistance = 40.f;
		float reflections, roomVolume, roomArea, roomSize, feedbackness = 0.f;
		if (!map) {
			reflections = 0.f;
			roomVolume = 1.f;
			roomArea = 1.f;
			roomSize = 10.f;
		} else {
			for (int rays = 0; rays < 4; rays++) {
				Vector3 dir = MakeVector3(SampleRandomFloat() - SampleRandomFloat(),
				                          SampleRandomFloat() - SampleRandomFloat(),
				                          SampleRandomFloat() - SampleRandomFloat()).Normalize();
				IntVector3 hitPos;
				bool hit = map->CastRay(eye, dir, maxDistance, hitPos);
				roomHistory[roomHistoryPos] =
				  hit ? (MakeVector3((float)hitPos.x, (float)hitPos.y, (float)hitPos.z) - eye).GetLength()
				      : maxDistance * 2.f;
				if (hit) roomFeedbackHistory[roomHistoryPos] = map->CastRay(eye, -dir, maxDistance, hitPos) ? 1.f : 0.f;
				if (++roomHistoryPos == (int)roomHistory.size()) roomHistoryPos = 0;
			}
			unsigned rayHitCount = 0;
			roomVolume = roomArea = roomSize = 0.f;
			for (size_t i = 0; i < roomHistory.size(); i++) {
				float dist = roomHistory[i];
				if (dist < maxDistance) {
					rayHitCount++;
					roomVolume += dist * dist;
					roomArea += dist;
					roomSize += dist;
				}
				feedbackness += roomFeedbackHistory[i];
			}
			if (rayHitCount > roomHistory.size() / 4) {
				roomVolume /= (float)rayHitCount;
				roomVolume *= 4.f / 3.f * (float)M_PI;
				roomArea /= (float)rayHitCount;
				roomArea *= 4.f * (float)M_PI;
				roomSize /= (float)rayHitCount;
				reflections = (float)rayHitCount / (float)roomHistory.size();
			} else {
				roomVolume = 8.f;
				reflections = 0.2f;
				roomArea = 100.f;
				roomSize = 100.f;
			}
			feedbackness /= (float)roomHistory.size();
		}
		// EFX limits: decay 0.1..20 s, late delay <= 0.1 s, reflections delay <= 0.3 s.
		float decay = std::min(std::max(.161f * roomVolume / roomArea / .4f, .1f), 20.f);
		float gain = reflections * 0.8f;
		float lateDelay = std::min(roomSize / 324.f, .1f);
		float reflDelay = std::min(roomSize / 324.f, .3f);
		float lateGain = reflections * reflections * reflections * reflections * feedbackness *
		                 feedbackness * feedbackness * .34f;
		float reflGain = reflections * .25f;
		MAIN_THREAD_ASYNC_EM_ASM({
			if (Module['fullAudio']) Module['fullAudio'].reverb($0, $1, $2, $3, $4, $5);
		}, decay, gain, reflGain, lateGain, reflDelay, lateDelay);
	}
} // namespace spades::audio
