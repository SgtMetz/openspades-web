// Automated integration check of the original native UI, skins and software renderer.
// Does not open a browser, join a server or conduct an interactive playtest.
#include <Audio/NullDevice.h>
#include <Core/Bitmap.h>
#include <Core/Exception.h>
#include <Draw/SWRenderer.h>
#include <Draw/SWPort.h>
#include <Client/Fonts.h>
#include <Gui/MainScreen.h>
#include <ScriptBindings/ScriptFunction.h>
#include <ScriptBindings/IToolSkin.h>
#include <ScriptBindings/IViewToolSkin.h>
#include <ScriptBindings/IThirdPersonToolSkin.h>
#include <ScriptBindings/ISpadeSkin.h>
#include <ScriptBindings/IWeaponSkin.h>
#include <ScriptBindings/IGrenadeSkin.h>
#include <ScriptBindings/IBlockSkin.h>
#include <algorithm>
#include <cstdio>
using namespace spades;
using namespace spades::client;
namespace {
class MemoryPort : public draw::SWPort {
  Handle<Bitmap> image = Handle<Bitmap>::New(1024,640);
public:
  unsigned frames = 0;
  Bitmap &GetFramebuffer() override { return *image; }
  void Swap() override { ++frames; }
};
}
int VerifyOriginalRuntime() {
  auto port = Handle<MemoryPort>::New();
  auto renderer = Handle<draw::SWRenderer>::New(port.Cast<draw::SWPort>()).Cast<IRenderer>();
  auto audio = Handle<audio::NullDevice>::New().Cast<IAudioDevice>();
  auto fonts = Handle<FontManager>::New(renderer.GetPointerOrNull());
  auto menu = Handle<gui::MainScreen>::New(renderer,audio,fonts);
  for (int i = 0; i < 20; ++i) { menu->RunFrame(1.f/30); menu->RunFrameLate(1.f/30); }
  if (port->frames < 10) SPRaise("Original scripted menu did not present frames");
  auto &bitmap = port->GetFramebuffer();
  auto *pixels = bitmap.GetPixels();
  unsigned changed = 0;
  for (int i = 1; i < bitmap.GetWidth()*bitmap.GetHeight(); ++i) changed += pixels[i] != pixels[0];
  if (changed < 10000) SPRaise("Original scripted UI produced a blank frame");
  printf("PASS: original AngelScript menu and title map render (%u frames, %u varying pixels)\n",port->frames,changed);

  for (const char *tool : {"Spade","Block","Grenade","Rifle","SMG","Shotgun"}) {
    std::string interface = std::string(tool) == "Spade" ? "ISpadeSkin" : std::string(tool) == "Block" ? "IBlockSkin" : std::string(tool) == "Grenade" ? "IGrenadeSkin" : "IWeaponSkin";
    for (const char *perspective : {"View","ThirdPerson"}) {
      std::string signature = interface + "@ Create" + perspective + tool + "Skin(Renderer@, AudioDevice@)";
      ScriptFunction factory(signature);
      auto context = factory.Prepare();
      context->SetArgObject(0,renderer.GetPointerOrNull()); context->SetArgObject(1,audio.GetPointerOrNull());
      context.ExecuteChecked();
      auto *skin = static_cast<asIScriptObject *>(context->GetReturnObject());
      if (!skin) SPRaise("Skin factory returned null: %s",tool);
      ScriptIToolSkin common(skin);
      common.SetMuted(true); common.SetRaiseState(1); common.SetSprintState(0); common.SetTeamColor(MakeVector3(.3,.5,.7));
      for (int i = 0; i < 8; ++i) {
        common.Update(1.f/60);
        SceneDefinition scene;
        scene.viewportLeft = scene.viewportTop = 0; scene.viewportWidth = 1024; scene.viewportHeight = 640;
        scene.fovX = 1.3f; scene.fovY = .8f; scene.zNear = .01f; scene.zFar = 128;
        scene.viewOrigin = MakeVector3(0,0,0);
        scene.viewAxis[0] = MakeVector3(1,0,0); scene.viewAxis[1] = MakeVector3(0,0,-1); scene.viewAxis[2] = MakeVector3(0,1,0);
        scene.skipWorld = true;
        renderer->StartScene(scene);
        if (std::string(perspective) == "View") {
          ScriptIViewToolSkin view(skin); view.SetEyeMatrix(Matrix4::Identity()); view.SetSwing(MakeVector3(0,0,0));
        } else { ScriptIThirdPersonToolSkin third(skin); third.SetOriginMatrix(Matrix4::Identity()); }
        common.AddToScene(); renderer->EndScene(); renderer->FrameDone(); renderer->Flip();
      }
      printf("PASS: original %s %s skin constructed and rendered\n",perspective,tool);
    }
  }
  menu->Closing();
  printf("PASS: full original runtime integration\n");
  return 0;
}

// Automated WebGL 2 check (headless browser, no input): runs the real SDLRunner client loop with
// the original GLRenderer and scripted main menu, whose background is the 3D title map scene,
// for a fixed number of frames, then reports shader links and frame contents.
#include <Gui/Runner.h>
#include <Gui/MainScreen.h>
#include <Core/Settings.h>
#include <Core/Debug.h>
#include <Core/FileManager.h>
#include <set>
extern "C" unsigned osweb_linked_program_count();
int VerifyWebGL() {
  using namespace spades;
  Settings::ItemHandle("r_renderer", nullptr) = std::string("gl");
  Settings::ItemHandle("r_ignoreGLErrors", nullptr) = 0; // raise at the failing GL call
  class Probe : public gui::View {
    Handle<gui::MainScreen> menu;
    IRenderer &renderer;
    int frames = 0;
  public:
    bool ok = false;
    Probe(IRenderer *r, IAudioDevice *a) : renderer(*r) {
      auto fonts = Handle<FontManager>::New(r);
      menu = Handle<gui::MainScreen>::New(Handle<IRenderer>(r), Handle<IAudioDevice>(a), fonts);
      // Register every original sound through the real audio device; the page reports how
      // many the browser decoded (headless-check.mjs).
      // ZipFileSystem::EnumFiles lists only the files directly inside a directory, so the
      // original sound directories are named explicitly (source "_Assets_" folders excluded).
      unsigned sounds = 0;
      // A ".weak" file is the GPL fallback for the same name in pak000-Nonfree; FileManager
      // opens whichever is present, so it is registered under the name without ".weak".
      std::set<std::string> seen;
      for (const char *dir : {"Sounds", "Sounds/Feedback", "Sounds/Feedback/CTF",
                              "Sounds/Feedback/Limbo", "Sounds/Feedback/TC", "Sounds/Misc",
                              "Sounds/Player", "Sounds/Weapons", "Sounds/Weapons/Block",
                              "Sounds/Weapons/Grenade", "Sounds/Weapons/Grenade/WaterExplode",
                              "Sounds/Weapons/Impacts", "Sounds/Weapons/Rifle",
                              "Sounds/Weapons/SMG", "Sounds/Weapons/Shotgun",
                              "Sounds/Weapons/Spade"}) {
        for (auto name : FileManager::EnumFiles(dir)) {
          if (name.size() > 5 && name.substr(name.size() - 5) == ".weak") name.resize(name.size() - 5);
          if (!seen.insert(std::string(dir) + "/" + name).second) continue;
          bool opus = name.size() > 5 && name.substr(name.size() - 5) == ".opus";
          bool wav = name.size() > 4 && name.substr(name.size() - 4) == ".wav";
          if (!opus && !wav) continue;
          a->RegisterSound((std::string(dir) + "/" + name).c_str());
          ++sounds;
        }
      }
      printf("OSWEB-AUDIO: %u original sounds registered\n", sounds);
    }
    void RunFrame(float dt) override { menu->RunFrame(dt); }
    void RunFrameLate(float dt) override {
      menu->RunFrameLate(dt);
      if (++frames == 120) {
        // Pixels are checked on the page (headless-check.mjs) from the frames actually presented.
        unsigned programs = osweb_linked_program_count();
        printf("OSWEB-GL: %d frames, %u GLSL ES programs linked\n", frames, programs);
        ok = programs > 10;
        printf(ok ? "PASS: original GL renderer and scripted menu rendered through WebGL 2\n"
                  : "FAIL: WebGL frame check\n");
      }
    }
    bool WantsToBeClosed() override { return frames >= 600; } // keep presenting for the screenshot
    void Closing() override { menu->Closing(); }
  };
  class App : public gui::Runner {
  public:
    Probe *probe = nullptr;
    gui::View *CreateView(IRenderer *r, IAudioDevice *a) override { return probe = new Probe(r, a); }
  } app;
  app.Run(); // not RunProtected: errors must surface to the check
  bool ok = app.probe && app.probe->ok;
  printf("OSWEB-GL-RESULT: %s\n", ok ? "PASS" : "FAIL");
  return ok ? 0 : 1;
}
