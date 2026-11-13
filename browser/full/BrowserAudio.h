#pragma once
// Web Audio implementation of the original IAudioDevice, following Audio/ALDevice.cpp:
// sounds are read through FileManager (paks, .weak fallbacks, user overrides), decoded by the
// browser, played with the same gain/pitch/inverse-clamped distance model, listener-relative
// "local" sounds, s_maxPolyphonics, and s_eax reverb/obstruction estimated by the same map
// raycasts as the desktop EFX path (rendered with a convolver and a low-pass filter).
#include <Client/IAudioDevice.h>
#include <Client/IAudioChunk.h>
#include <Core/Math.h>
#include <map>
#include <string>
#include <vector>

namespace spades {
	namespace client {
		class GameMap;
	}
} // namespace spades

namespace spades::audio {
	class BrowserAudio : public client::IAudioDevice {
		class Chunk : public client::IAudioChunk {
		public:
			std::string name;
			int id;
			Chunk(const char *n, int i) : name(n), id(i) {}
		};
		std::map<std::string, Handle<Chunk>> chunks;
		client::GameMap *map = nullptr;
		Vector3 eye{0, 0, 0}, front{0, 1, 0}, up{0, 0, -1};
		std::vector<float> roomHistory, roomFeedbackHistory;
		int roomHistoryPos = 0;
		int nextId = 1;
		void play(client::IAudioChunk *, Vector3, const client::AudioParam &, int mode);
		bool Obstructed(const Vector3 &pos);
		void UpdateReverb();

	public:
		BrowserAudio();
		~BrowserAudio();
		static bool TryLoad() { return true; }
		static std::vector<std::string> DeviceList() { return {"Browser default"}; }
		client::IAudioChunk *RegisterSound(const char *) override;
		void ClearCache() override;
		void SetGameMap(client::GameMap *) override;
		void Play(client::IAudioChunk *, const Vector3 &, const client::AudioParam &) override;
		void PlayLocal(client::IAudioChunk *, const Vector3 &, const client::AudioParam &) override;
		void PlayLocal(client::IAudioChunk *, const client::AudioParam &) override;
		void Respatialize(const Vector3 &, const Vector3 &, const Vector3 &) override;
	};
} // namespace spades::audio
