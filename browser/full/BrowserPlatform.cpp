// Browser equivalents for desktop shell services used by the original client:
//  * Clipboard (ScriptBindings/Clipboard.cpp): the system clipboard via the page (paste events
//    and navigator.clipboard.writeText). SDL's Emscripten port has no clipboard driver.
//  * OpenURLInBrowser / ShowDirectoryInShell (Core/ShellApi.cpp): the desktop runs xdg-open or
//    ShellExecute. The page shows the link (popup blockers reject window.open without a click)
//    or the saved-files dialog for the user directory.
#include <emscripten.h>
#include <cstdlib>

extern "C" {
char *osweb_get_clipboard() {
	return (char *)MAIN_THREAD_EM_ASM_PTR({
		var text = Module["osClipboard"] || "";
		return stringToNewUTF8(text);
	});
}
void osweb_set_clipboard(const char *text) {
	MAIN_THREAD_EM_ASM({
		var text = UTF8ToString($0);
		Module['osClipboard'] = text;
		if (navigator.clipboard && navigator.clipboard.writeText)
			navigator.clipboard.writeText(text).catch(function(e) { console.warn('Clipboard write failed:', e.message); });
	}, text);
}
int osweb_open_url(const char *url) {
	return MAIN_THREAD_EM_ASM_INT({
		var url = UTF8ToString($0);
		var lower = url.toLowerCase();
		if (lower.indexOf("http:") !== 0 && lower.indexOf("https:") !== 0) return 0;
		if (Module['osOpenURL']) Module['osOpenURL'](url);
		return 1;
	}, url);
}
int osweb_show_directory(const char *path) {
	return MAIN_THREAD_EM_ASM_INT({
		if (Module['showUserFiles']) Module['showUserFiles'](UTF8ToString($0));
		return 1;
	}, path);
}
// r_fullscreen and Alt+Enter (SDLRunner): the page, not the input canvas, goes fullscreen,
// because frames are shown on the #native-view overlay. Returns 0 like SDL_SetWindowFullscreen.
int osweb_set_fullscreen(int on) {
	return MAIN_THREAD_EM_ASM_INT({
		if (Module['osSetFullscreen']) Module['osSetFullscreen'](!!$0);
		return 0;
	}, on);
}
int osweb_is_fullscreen() {
	return MAIN_THREAD_EM_ASM_INT({ return document.fullscreenElement ? 1 : 0; });
}
// Graphics quality chosen by the page's device test (browser.js), as "name value" lines; null
// when there is none. Returns a malloc'ed string the caller frees.
char *osweb_quality_settings() {
	return (char *)MAIN_THREAD_EM_ASM_PTR({
		var q = Module['osQuality'];
		if (!q || !q.settings) return 0;
		var lines = Object.keys(q.settings).map(function(k) { return k + ' ' + q.settings[k]; });
		return stringToNewUTF8(lines.join('\n'));
	});
}
// In-game Graphics buttons (prepare.py, Menu.as): the page saves the preset and restarts the
// client with it (browser.js osRequestQuality).
void osweb_request_quality(const char *tier) {
	MAIN_THREAD_EM_ASM({
		if (Module['osRequestQuality']) Module['osRequestQuality'](UTF8ToString($0));
	}, tier);
}
int osweb_show_launcher() {
	return MAIN_THREAD_EM_ASM_INT({ return Module['osShowLauncher'] ? 1 : 0; });
}
// Touch devices (browser.js): on-screen controls. Enabled once per page by device detection or
// the ?touch=1/0 override; desktop pages never poll.
int osweb_touch_enabled() {
	return MAIN_THREAD_EM_ASM_INT({ return Module['osTouchEnabled'] ? 1 : 0; });
}
// Input queued since the last frame, one item per line: "+Name"/"-Name" (key or mouse button down
// or up, in the names SDLRunner gives desktop input), "tText" (typed text), "mDX DY" (look motion).
// Returns null when nothing is queued; otherwise a malloc'ed string the caller frees.
char *osweb_touch_poll(int relative, int textInput) {
	return (char *)MAIN_THREAD_EM_ASM_PTR({
		var s = Module['osTouchPoll'] ? Module['osTouchPoll']($0, $1) : "";
		return s ? stringToNewUTF8(s) : 0;
	}, relative, textInput);
}
}
