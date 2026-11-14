"""Prepare a reproducible browser-specific copy of the original desktop sources.

The source checkout and current gameplay port remain unchanged. The only generated
changes are platform adaptation and generic AngelScript call wrappers.
"""
from pathlib import Path
import re
import shutil
import zipfile
from wrappers import generate as generate_wrappers

ROOT = Path(__file__).resolve().parent
UPSTREAM = ROOT.parent.parent / 'openspades'
OUT = ROOT / 'generated'
AS = UPSTREAM / 'Sources' / 'AngelScript'

generate_wrappers()

def copy_tree(source, destination):
    for path in source.rglob('*'):
        if not path.is_file():
            continue
        target = destination / path.relative_to(source)
        target.parent.mkdir(parents=True, exist_ok=True)
        if not target.exists() or path.read_bytes() != target.read_bytes():
            shutil.copyfile(path, target)

copy_tree(UPSTREAM / 'Sources', OUT)

def patch(path, before, after):
    file = OUT / path
    text = file.read_text(encoding='utf-8-sig')
    if before not in text:
        raise RuntimeError(f'Upstream context changed: {path}: {before[:50]}')
    file.write_text(text.replace(before, after), encoding='utf-8')

# Restore the desktop hit-test debugger and AngelScript include in this build.
for path in ['Client/Player.cpp', 'Client/World.cpp', 'Client/World.h', 'Core/RefCountedObject.cpp']:
    file = OUT / path
    text = file.read_text(encoding='utf-8-sig')
    file.write_text(text.replace('__EMSCRIPTEN__', 'OSWEB_GAMEPLAY_ONLY'), encoding='utf-8')

def end_paren(text, start):
    depth, quote, escape = 0, None, False
    for i in range(start, len(text)):
        ch = text[i]
        if quote:
            if escape: escape = False
            elif ch == '\\': escape = True
            elif ch == quote: quote = None
        elif ch in '\"\'': quote = ch
        elif ch == '(': depth += 1
        elif ch == ')':
            depth -= 1
            if depth == 0: return i + 1
    raise RuntimeError('Unbalanced function registration')

converted = 0
for file in [f for f in OUT.rglob('*.cpp') if 'AngelScript' not in f.relative_to(OUT).parts]:
    text = file.read_text(encoding='utf-8-sig')
    edits = []
    for match in re.finditer(r'\bas(FUNCTIONPR|METHODPR|FUNCTION|METHOD)\s*\(', text):
        end = end_paren(text, match.end() - 1)
        conv = re.match(r'\s*,\s*asCALL_(CDECL_OBJLAST|CDECL_OBJFIRST|CDECL|THISCALL)\b', text[end:])
        if not conv: continue
        macro, args = match.group(1), text[match.end():end - 1]
        if args.strip() == 'MessageCallback': continue  # engine callback is native, not a script call
        if macro.startswith('METHOD'): wrapper = 'WRAP_MFN'
        elif conv.group(1) == 'CDECL_OBJLAST': wrapper = 'WRAP_OBJ_LAST'
        elif conv.group(1) == 'CDECL_OBJFIRST': wrapper = 'WRAP_OBJ_FIRST'
        else: wrapper = 'WRAP_FN'
        if macro.endswith('PR'): wrapper += '_PR'
        edits.append((match.start(), end + conv.end(), f'{wrapper}({args}), asCALL_GENERIC'))
    for start, end, replacement in reversed(edits):
        text = text[:start] + replacement + text[end:]
    if edits:
        text = '#include <aswrappedcall.h>\n' + text
        file.write_text(text, encoding='utf-8')
        converted += len(edits)

# Browser audio implements IAudioDevice; the original skins choose all sounds.
patch('Gui/SDLRunner.cpp', '#include <Audio/ALDevice.h>', '#include <BrowserAudio.h>')
patch('Gui/SDLRunner.cpp', '#include <Audio/YsrDevice.h>', '')
patch('Gui/SDLRunner.cpp', 'return new audio::ALDevice();', 'return new audio::BrowserAudio();')
patch('Gui/SDLRunner.cpp', 'return new audio::YsrDevice();', 'return new audio::BrowserAudio();')
patch('Gui/StartupScreenHelper.cpp', '#include <Audio/ALDevice.h>', '#include <BrowserAudio.h>')
# Browsers keep Escape for leaving pointer lock and do not deliver it to the page, so P also
# opens the in-game menu (Setup there opens the settings). SDL names the key "P". Chat and other
# UI text input are handled before this branch, so typing "p" is unaffected.
patch('Client/Client_Input.cpp', 'if (name == "Escape") {',
      'if (name == "Escape" || (EqualsIgnoringCase(name, "p") && !cg_debugCorpse)) {')
patch('Gui/StartupScreenHelper.cpp', '#include <Audio/YsrDevice.h>', '')
patch('Gui/StartupScreenHelper.cpp', 'audio::ALDevice::', 'audio::BrowserAudio::')
patch('Gui/StartupScreenHelper.cpp', 'audio::YsrDevice::TryLoadYsr()', 'false')

# A 3D/OpenGL backend is compiled too; browser-specific adaptations are in its device.
patch('Core/VersionInfo.cpp', '#if __linux__', '#if defined(__EMSCRIPTEN__)\n\t#define OS_PLATFORM_LINUX\n#elif __linux__')
patch('Gui/MainScreenHelper.cpp', 'http://services.buildandshoot.com', 'https://services.buildandshoot.com')
patch('AngelScript/addons/scriptstdstring.cpp', 'new (nothrow)', 'new (std::nothrow)')
patch('AngelScript/addons/scriptstdstring.cpp', '#include "scriptstdstring.h"', '#include <new>\n#include "scriptstdstring.h"')

# WebGL 2: the original device's GL calls go through WebGLShim.h (shader merge/translation,
# texture formats, depth copies, queries); frames are handed to the page after each swap.
patch('Gui/SDLGLDevice.cpp', '#include "SDLGLDevice.h"', '#include "SDLGLDevice.h"\n#include <WebGLShim.h>\nextern "C" void osweb_present();\nextern "C" void *osweb_create_gl_context();\nextern "C" void osweb_destroy_gl_context(void *);')
# SDL's Emscripten GLES path creates contexts through EGL, which is proxied to the page thread;
# the WebGL 2 context must belong to the client thread that owns the OffscreenCanvas.
patch('Gui/SDLGLDevice.cpp', 'context = SDL_GL_CreateContext(s);', 'context = (SDL_GLContext)osweb_create_gl_context();')
patch('Gui/SDLGLDevice.cpp', 'SDL_GL_MakeCurrent(window, context);', '// made current by osweb_create_gl_context')
patch('Gui/SDLGLDevice.cpp', 'SDL_GL_DeleteContext(context);', 'osweb_destroy_gl_context(context);')
patch('Gui/SDLGLDevice.cpp', 'SDL_GL_SwapWindow(window);', 'osweb_present();')
patch('Gui/SDLRunner.cpp', 'SDL_GL_SetSwapInterval(vsync) != 0', 'osweb_set_swap_interval(vsync) != 0')
patch('Gui/SDLRunner.cpp', '#include "SDLRunner.h"', '#include "SDLRunner.h"\nextern "C" int osweb_set_swap_interval(int);\n'
      'extern "C" int osweb_set_fullscreen(int);\nextern "C" int osweb_is_fullscreen();')
# Fullscreen applies to the page (BrowserPlatform.cpp). Alt+Enter toggles from the page's actual
# state, since the browser can also leave fullscreen (Esc).
patch('Gui/SDLRunner.cpp', '// Toggle fullscreen mode\n\t\t\t\t\t\t\tif (r_fullscreen) {',
      '// Toggle fullscreen mode\n\t\t\t\t\t\t\tif (osweb_is_fullscreen()) {')
patch('Gui/SDLRunner.cpp', 'if (!SDL_SetWindowFullscreen(window, 0)) {', 'if (!osweb_set_fullscreen(0)) {')
patch('Gui/SDLRunner.cpp', 'if (!SDL_SetWindowFullscreen(window, SDL_WINDOW_FULLSCREEN)) {', 'if (!osweb_set_fullscreen(1)) {')
patch('Gui/SDLRunner.cpp', 'sdlFlags |= SDL_WINDOW_FULLSCREEN;', 'osweb_set_fullscreen(1);')
patch('Gui/SDLRunner.cpp', 'SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 0);',
      'SDL_GL_SetAttribute(SDL_GL_DEPTH_SIZE, 0);\n'
      '\t\t\t\t\t\tSDL_GL_SetAttribute(SDL_GL_CONTEXT_PROFILE_MASK, SDL_GL_CONTEXT_PROFILE_ES);\n'
      '\t\t\t\t\t\tSDL_GL_SetAttribute(SDL_GL_CONTEXT_MAJOR_VERSION, 3);\n'
      '\t\t\t\t\t\tSDL_GL_SetAttribute(SDL_GL_CONTEXT_MINOR_VERSION, 0);')
# The client loop never returns to the worker's event loop, so browser input proxied to this
# thread is drained explicitly each frame; preferences are saved as they change (a tab can be
# closed without the desktop's orderly exit).
patch('Gui/SDLRunner.cpp', '#include "SDLRunner.h"', '#include "SDLRunner.h"\n#include <emscripten/threading.h>')
patch('Gui/SDLRunner.cpp', 'DispatchQueue::GetThreadQueue()->ProcessQueue();',
      'emscripten_current_thread_process_queued_calls();\n'
      '\t\t\t\t\tif (SDL_GetTicks() - lastSettingsSave > 2000) {\n'
      '\t\t\t\t\t\tSettings::GetInstance()->Flush();\n'
      '\t\t\t\t\t\tlastSettingsSave = SDL_GetTicks();\n'
      '\t\t\t\t\t}\n'
      '\t\t\t\t\tDispatchQueue::GetThreadQueue()->ProcessQueue();')
patch('Gui/SDLRunner.cpp', 'bool absoluteMouseCoord = true;', 'bool absoluteMouseCoord = true;\n\t\t\t\tUint32 lastSettingsSave = SDL_GetTicks();')
# Touch devices (browser.js): on-screen controls deliver the same key names, text and relative
# mouse motion as desktop input, so bindings and sensitivity settings apply unchanged.
patch('Gui/SDLRunner.cpp', '#include "SDLRunner.h"', '#include "SDLRunner.h"\n#include <cstdio>\n#include <cstdlib>\n'
      'extern "C" int osweb_touch_enabled();\nextern "C" char *osweb_touch_poll(int, int);')
patch('Gui/SDLRunner.cpp', 'bool absoluteMouseCoord = true;', 'bool absoluteMouseCoord = true;\n\t\t\t\tconst bool touchControls = osweb_touch_enabled() != 0;')
patch('Gui/SDLRunner.cpp', '\t\t\t\t\twhile (SDL_PollEvent(&event)) {',
      '\t\t\t\t\tif (touchControls) {\n'
      '\t\t\t\t\t\tif (char *touch = osweb_touch_poll(absoluteMouseCoord ? 0 : 1, editing ? 1 : 0)) {\n'
      '\t\t\t\t\t\t\tstd::string queued(touch);\n'
      '\t\t\t\t\t\t\tfree(touch);\n'
      '\t\t\t\t\t\t\tsize_t pos = 0;\n'
      '\t\t\t\t\t\t\twhile (pos < queued.size()) {\n'
      '\t\t\t\t\t\t\t\tsize_t end = queued.find(\'\\n\', pos);\n'
      '\t\t\t\t\t\t\t\tif (end == std::string::npos) end = queued.size();\n'
      '\t\t\t\t\t\t\t\tstd::string item = queued.substr(pos, end - pos);\n'
      '\t\t\t\t\t\t\t\tpos = end + 1;\n'
      '\t\t\t\t\t\t\t\tif (item.size() < 2) continue;\n'
      '\t\t\t\t\t\t\t\tconst std::string arg = item.substr(1);\n'
      '\t\t\t\t\t\t\t\tfloat dx, dy;\n'
      '\t\t\t\t\t\t\t\tif (item[0] == \'+\' || item[0] == \'-\') view->KeyEvent(arg, item[0] == \'+\');\n'
      '\t\t\t\t\t\t\t\telse if (item[0] == \'t\') view->TextInputEvent(arg);\n'
      '\t\t\t\t\t\t\t\telse if (item[0] == \'m\' && !absoluteMouseCoord && std::sscanf(arg.c_str(), "%f %f", &dx, &dy) == 2)\n'
      '\t\t\t\t\t\t\t\t\tview->MouseEvent(dx, dy);\n'
      '\t\t\t\t\t\t\t}\n'
      '\t\t\t\t\t\t}\n'
      '\t\t\t\t\t}\n\n'
      '\t\t\t\t\twhile (SDL_PollEvent(&event)) {')
patch('Core/Settings.cpp', 'SPLog("Saving preference to " CONFIGFILE);\n', '')
# Save() is now called every 2 s (SDLRunner patch), so it logs only when it actually writes.
patch('Core/Settings.cpp', '\t\tSPLog("Saving preferences to " CONFIGFILE);\n', '')
patch('Core/Settings.cpp', 'std::unique_ptr<IStream> s(FileManager::OpenForWriting(CONFIGFILE));',
      'static std::string lastSaved;\n\t\t\tif (buffer == lastSaved) return;\n'
      '\t\t\tSPLog("Saving preferences to " CONFIGFILE);\n\t\t\tlastSaved = buffer;\n'
      '\t\t\tstd::unique_ptr<IStream> s(FileManager::OpenForWriting(CONFIGFILE));')

# Desktop shell services (xdg-open/ShellExecute, SDL clipboard) map to page equivalents
# implemented in BrowserPlatform.cpp and browser.js.
patch('ScriptBindings/Clipboard.cpp', 'namespace spades{', 'extern "C" char *osweb_get_clipboard();\nextern "C" void osweb_set_clipboard(const char *);\nnamespace spades{')
patch('ScriptBindings/Clipboard.cpp', 'SDL_GetClipboardText()', 'osweb_get_clipboard()')
patch('ScriptBindings/Clipboard.cpp', 'SDL_free(txt);', 'free(txt);')
patch('ScriptBindings/Clipboard.cpp', 'SDL_SetClipboardText(s.c_str());', 'osweb_set_clipboard(s.c_str());')
patch('Core/ShellApi.cpp', '#if defined(__APPLE__)',
      'extern "C" int osweb_open_url(const char *);\n'
      'extern "C" int osweb_show_directory(const char *);\n'
      '#if defined(__EMSCRIPTEN__)\n'
      '\tbool ShowDirectoryInShell(const std::string &path) { return osweb_show_directory(path.c_str()) != 0; }\n'
      '\tbool OpenURLInBrowser(const std::string &url) { return osweb_open_url(url.c_str()) != 0; }\n'
      '#elif defined(__APPLE__)')

# WebGL fixes a buffer's type at its first bind and forbids using one buffer for both vertex and
# index data. The original uploads index data through GL_ARRAY_BUFFER; upload it through
# GL_ELEMENT_ARRAY_BUFFER instead (same data, same later bindings).
index_uploads = 0
for path in ['Draw/GLMapChunk.cpp', 'Draw/GLOptimizedVoxelModel.cpp', 'Draw/GLVoxelModel.cpp', 'Draw/GLWaterRenderer.cpp']:
    file = OUT / path
    text = file.read_text(encoding='utf-8-sig')
    text, n = re.subn(r'((?:idxBuffer|iBuffer) = device\.GenBuffer\(\);\s*)device\.BindBuffer\(IGLDevice::ArrayBuffer, ((?:idxBuffer|iBuffer))\);(\s*)device\.BufferData\(IGLDevice::ArrayBuffer,([^;]*);',
                      r'\1device.BindBuffer(IGLDevice::ElementArrayBuffer, \2);\3device.BufferData(IGLDevice::ElementArrayBuffer,\4;\3device.BindBuffer(IGLDevice::ElementArrayBuffer, 0);', text)
    if n != 1: raise RuntimeError(f'Upstream context changed: {path}: index buffer upload')
    file.write_text(text, encoding='utf-8')
    index_uploads += n

# Software renderer: use SDL's plain window surface (drawn by the page, browser.js) rather than
# SDL's GL-accelerated texture framebuffer, which would need a context on the transferred canvas.
patch('Gui/SDLRunner.cpp', '\t\t\tSDL_Init(SDL_INIT_VIDEO);',
      '\t\t\tSDL_SetHint(SDL_HINT_FRAMEBUFFER_ACCELERATION, "0");\n\t\t\tSDL_Init(SDL_INIT_VIDEO);')

# Startup window capability probe: create the probe context like SDLGLDevice does, and report
# the desktop extension names whose features WebGL 2 provides in core (or via the WebGL
# extension named next to it) so the probe judges the browser like an equivalent desktop GPU.
patch('Gui/StartupScreenHelper.cpp', '#include <algorithm>',
      '#include <algorithm>\nextern "C" void *osweb_create_gl_context();\nextern "C" void osweb_destroy_gl_context(void *);')
patch('Gui/StartupScreenHelper.cpp', 'SDL_GLContext context = window ? SDL_GL_CreateContext(window) : nullptr;',
      'SDL_GLContext context = window ? (SDL_GLContext)osweb_create_gl_context() : nullptr;')
patch('Gui/StartupScreenHelper.cpp', '\t\t\t\tSDL_GL_MakeCurrent(window, context);\n', '')
patch('Gui/StartupScreenHelper.cpp', 'SDL_GL_DeleteContext(context);', 'osweb_destroy_gl_context(context);')
patch('Gui/StartupScreenHelper.cpp', '\t\t\t\tif (str)\n\t\t\t\t\textensions = str;\n',
      '\t\t\t\tif (str)\n\t\t\t\t\textensions = str;\n'
      '\t\t\t\t// WebGL 2 core: multitexture, GLSL, NPOT, VBO, FBO, sRGB attachments, blit, texture\n'
      '\t\t\t\t// arrays and occlusion queries (conditional rendering draws when results are pending).\n'
      '\t\t\t\textensions += " GL_ARB_multitexture GL_ARB_shader_objects GL_ARB_shading_language_100"\n'
      '\t\t\t\t              " GL_ARB_texture_non_power_of_two GL_ARB_vertex_buffer_object GL_EXT_framebuffer_object"\n'
      '\t\t\t\t              " GL_ARB_framebuffer_sRGB GL_EXT_framebuffer_blit GL_EXT_texture_array"\n'
      '\t\t\t\t              " GL_ARB_occlusion_query GL_NV_conditional_render";\n'
      '\t\t\t\tif (extensions.find("GL_EXT_color_buffer_float") != std::string::npos)\n'
      '\t\t\t\t\textensions += " GL_ARB_color_buffer_float";\n')

# AngelScript reports C++ exceptions from registered functions only as "Caught an exception from
# the application"; log GL errors where they are detected so SystemMessages.log keeps the cause.
patch('Gui/SDLGLDevice.cpp', '\t\t\tif (r_ignoreGLErrors) {\n\t\t\t\tSPRaise("GL error %s in %s at',
      '\t\t\tSPLog("GL error %s in %s at line %d", msg.c_str(), func, line);\n\t\t\tif (r_ignoreGLErrors) {\n\t\t\t\tSPRaise("GL error %s in %s at')

# MEMFS and the renderer are byte-for-byte upstream. Assets are mounted as original paks.
# Like the upstream build (Resources/CMakeLists.txt, mkpak.sh), the GPL paks are built from the
# same source revision as the code; the 0.1.3 release paks predate it (for example the release
# has Gfx/Spotlight.png where the code loads Gfx/Spotlight.jpg). Only the two externally
# distributed paks (pak000-Nonfree, font-unifont; PakLocation.txt) come from the release.
resources = ROOT / 'resources'
resources.mkdir(exist_ok=True)
release = ROOT.parent.parent / 'OpenSpades-0.1.3-Windows/Resources'
for name in ('pak000-Nonfree.pak', 'font-unifont.pak'):
    shutil.copyfile(release / name, resources / name)
shutil.copyfile(UPSTREAM / 'Resources/PackageInfo.json', resources / 'PackageInfo.json')
MKPAK = {  # mkpak.sh, in its order
    'pak002-Base.pak': ['License/Credits-pak002-Base.md', 'Gfx', 'Scripts/Main.as', 'Scripts/Gui',
                        'Scripts/Base', 'Shaders', 'Sounds/Feedback', 'Sounds/Misc', 'Sounds/Player',
                        'Textures'],
    'pak005-Models.pak': ['Maps', 'Models/MapObjects', 'Models/Player'],
    'pak010-BaseSkin.pak': ['License/Credits-pak010-BaseSkin.md', 'Scripts/Skin', 'Sounds/Weapons',
                            'Models/Weapons', 'Models/MapObjects'],
    'pak050-Locales.pak': ['License/Credits-pak050-Locales.md', 'Locales'],
    'pak999-References.pak': ['License/Credits-pak999-References.md', 'Scripts/Reference'],
}
for pak, entries in MKPAK.items():
    source = UPSTREAM / 'Resources'
    with zipfile.ZipFile(resources / pak, 'w', zipfile.ZIP_DEFLATED) as archive:
        for entry in entries:
            path = source / entry
            files = [path] if path.is_file() else sorted(p for p in path.rglob('*') if p.is_file())
            for file in files:
                relative = file.relative_to(source).as_posix()
                if '_Assets_' in relative or file.name == '.DS_Store': continue
                archive.write(file, relative)
copy_tree(UPSTREAM / 'Resources/Scripts', resources / 'Scripts')
copy_tree(UPSTREAM / 'Resources/Shaders', resources / 'Shaders')

# Loose /Resources files override the paks. The in-game menu gets a master volume slider
# (s_gain, applied to every new sound) and P closes it again like Escape.
def patch_resource(path, before, after):
    file = resources / path
    text = file.read_text(encoding='utf-8-sig')
    if before not in text:
        raise RuntimeError(f'Upstream context changed: {path}: {before[:50]}')
    file.write_text(text.replace(before, after), encoding='utf-8')
menu = 'Scripts/Gui/Client/Menu.as'
patch_resource(menu, 'float winW = 180.f, winH = 32.f * 4.f - 2.f;', 'float winW = 220.f, winH = 32.f * 5.f - 2.f;')
patch_resource(menu, """                @button.Activated = spades::ui::EventHandler(this.OnDisconnect);
                AddChild(button);
            }
""", """                @button.Activated = spades::ui::EventHandler(this.OnDisconnect);
                AddChild(button);
            }
            {
                spades::ui::Label label(Manager);
                label.Text = _Tr("Preferences", "Volume");
                label.Alignment = Vector2(0.f, 0.5f);
                label.Bounds = AABB2(winX, winY + 128.f, 60.f, 30.f);
                AddChild(label);
                ConfigSlider slider(Manager, "s_gain", 0.f, 1.f, 0.01f,
                                    ConfigNumberFormatter(0, "%", "", 100));
                slider.label.Alignment = Vector2(0.f, 0.5f);
                slider.Bounds = AABB2(winX + 60.f, winY + 134.f, winW - 60.f - 44.f, 18.f);
                AddChild(slider);
            }
""")
patch_resource(menu, 'if (IsEnabled and key == "Escape") {', 'if (IsEnabled and (key == "Escape" or key == "P")) {')
print(f'Prepared original runtime; {converted} script bindings use generic wrappers.')
