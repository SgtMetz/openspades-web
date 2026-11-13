// Browser entry point for the original client. Mirrors Sources/Gui/Main.cpp (which is not built:
// it depends on the desktop splash window and native directories) step for step:
// file systems, preferences, locale, script engine, then the startup window or main screen, or
// a direct connection when an aos:// address is given (the desktop command-line argument; the
// browser passes it from the page URL, see browser.js).
#include <Core/DirectoryFileSystem.h>
#include <Core/ZipFileSystem.h>
#include <Core/FileManager.h>
#include <Core/IStream.h>
#include <Core/Settings.h>
#include <Core/Strings.h>
#include <Core/Debug.h>
#include <Core/ServerAddress.h>
#include <Client/Fonts.h>
#include <Client/Client.h>
#include <Gui/Runner.h>
#include <Gui/MainScreen.h>
#include <Gui/ConsoleScreen.h>
#include <Gui/StartupScreen.h>
#include <Gui/PackageUpdateManager.h>
#include <ScriptBindings/ScriptManager.h>
#include <Imports/SDL.h>
#include <sys/stat.h>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <regex>
#include <strings.h>

bool browserVerification = false;
int VerifyOriginalRuntime();
int VerifyWebGL();
static bool verifyGL = false;

// Defined in the desktop Main.cpp, which this file replaces.
DEFINE_SPADES_SETTING(cl_showStartupWindow, "1");

extern "C" char *osweb_quality_settings();
extern "C" int osweb_show_launcher();

// The browser has no launcher step: the page tests the device and picks one of the startup
// window's quality presets plus a window size matching the page (browser.js). Apply them as the
// startup window would have, before any renderer is created.
static void ApplyBrowserQuality() {
	char *text = osweb_quality_settings();
	if (!text) return;
	std::string lines(text);
	free(text);
	size_t pos = 0;
	while (pos < lines.size()) {
		size_t end = lines.find('\n', pos);
		if (end == std::string::npos) end = lines.size();
		std::string line = lines.substr(pos, end - pos);
		pos = end + 1;
		size_t space = line.find(' ');
		if (space == std::string::npos) continue;
		spades::Settings::ItemHandle(line.substr(0, space), nullptr) = line.substr(space + 1);
	}
}

namespace spades {
	std::string g_userResourceDirectory = "/user";

	void StartClient(const ServerAddress &addr) {
		class ConcreteRunner : public gui::Runner {
			ServerAddress addr;

		protected:
			gui::View *CreateView(client::IRenderer *renderer, client::IAudioDevice *audio) override {
				auto fontManager = Handle<client::FontManager>::New(renderer);
				auto innerView = Handle<client::Client>::New(renderer, audio, addr, fontManager);
				return new gui::ConsoleScreen(renderer, audio, fontManager,
				                              std::move(innerView).Cast<gui::View>());
			}

		public:
			ConcreteRunner(const ServerAddress &addr) : addr(addr) {}
		};
		ConcreteRunner runner(addr);
		runner.RunProtected();
	}
	void StartMainScreen() {
		class ConcreteRunner : public gui::Runner {
		protected:
			gui::View *CreateView(client::IRenderer *renderer, client::IAudioDevice *audio) override {
				auto fontManager = Handle<client::FontManager>::New(renderer);
				auto innerView = Handle<gui::MainScreen>::New(renderer, audio, fontManager);
				return new gui::ConsoleScreen(renderer, audio, fontManager,
				                              std::move(innerView).Cast<gui::View>());
			}
		};
		ConcreteRunner runner;
		runner.RunProtected();
	}
} // namespace spades

int main(int argc, char **argv) {
	using namespace spades;
	bool autoconnect = false;
	std::string autoconnectHost;
	ProtocolVersion protocol = ProtocolVersion::v075;
	const std::regex hostNameRegex{"aos://.*"};
	const std::regex v075Regex{"(?:v=)?0?\\.?75"};
	const std::regex v076Regex{"(?:v=)?0?\\.?76"};
	for (int i = 1; i < argc; ++i) {
		if (!std::strcmp(argv[i], "--verify")) browserVerification = true;
		else if (!std::strcmp(argv[i], "--verify-gl")) verifyGL = true;
		else if (std::regex_match(argv[i], hostNameRegex)) autoconnect = true, autoconnectHost = argv[i];
		else if (std::regex_match(argv[i], v075Regex)) protocol = ProtocolVersion::v075;
		else if (std::regex_match(argv[i], v076Regex)) protocol = ProtocolVersion::v076;
	}
	try {
		SDL_Init(SDL_INIT_TIMER);
		mkdir("/user", 0777);
		// Desktop: user directory first (read/write), then bundled resources, then paks in
		// reverse-sorted order so later paks override earlier ones.
		FileManager::AddFileSystem(new DirectoryFileSystem("/user", true));
		FileManager::AppendFileSystem(new DirectoryFileSystem("/Resources", false));
		auto files = FileManager::EnumFiles("");
		std::sort(files.begin(), files.end());
		for (auto it = files.rbegin(); it != files.rend(); ++it) {
			if (it->size() > 4 && it->substr(it->size() - 4) == ".pak") {
				auto stream = FileManager::OpenForReading(it->c_str());
				FileManager::AppendFileSystem(new ZipFileSystem(stream.release()));
			}
		}
		Settings::GetInstance()->Load();
		if (!browserVerification) ApplyBrowserQuality();
		if (browserVerification) {
			// Deterministic, headless configuration for the automated check only.
			Settings::ItemHandle("r_swNumThreads", nullptr) = 2;
			Settings::ItemHandle("core_numDispatchQueueThreads", nullptr) = 2;
		}
		LoadCurrentLocale();
		ScriptManager::GetInstance();
		if (browserVerification) return VerifyOriginalRuntime();

		SDL_InitSubSystem(SDL_INIT_VIDEO);
		if (verifyGL) return VerifyWebGL();
		// Desktop shows the startup window (launcher) first; the browser goes straight to the main
		// menu with tested settings, unless the page asks for the launcher (?launcher).
		if (!autoconnect) {
			if (!osweb_show_launcher()) {
				SPLog("Starting main screen");
				StartMainScreen();
			} else {
				SPLog("Starting startup window");
				gui::StartupScreen::Run();
			}
		} else {
			StartClient(ServerAddress(autoconnectHost, protocol));
		}
		Settings::GetInstance()->Flush();
		FileManager::Close();
		return 0;
	} catch (const std::exception &e) {
		fprintf(stderr, "FULL CLIENT ERROR: %s\n", e.what());
		return 1;
	}
}
