// WebGL 2 implementations of the OpenGL calls made by the original SDLGLDevice.
// See WebGLShim.h. Nothing here changes renderer behavior; it maps desktop GL semantics onto
// the closest legal WebGL 2 equivalent:
//  * Shader objects are recorded; at link time all objects of a stage are merged, translated to
//    GLSL ES 3.00 (ShaderTranslator) and compiled as one shader per stage.
//  * BGRA uploads are swizzled, unsized/desktop-only texture formats become legal sized formats.
//  * Depth CopyTexSubImage2D (illegal in WebGL) is done with a depth blit.
//  * SAMPLES_PASSED becomes ANY_SAMPLES_PASSED; conditional rendering draws when the result is
//    not yet available (WebGL never makes results available within the same frame).
//  * Capabilities that do not exist in WebGL (GL_TEXTURE_2D, GL_MULTISAMPLE,
//    GL_FRAMEBUFFER_SRGB) are ignored; WebGL always multisamples multisampled targets and always
//    encodes sRGB attachments.
#include "ShaderTranslator.h"

#include <GL/glew.h>
#include <emscripten.h>
#include <emscripten/threading.h>
#include <emscripten/html5_webgl.h>
#include <unistd.h>

#include <cstdio>
#include <cstring>
#include <map>
#include <string>
#include <vector>

#ifndef GL_BGRA
#define GL_BGRA 0x80E1
#endif
#ifndef GL_MULTISAMPLE
#define GL_MULTISAMPLE 0x809D
#endif
#ifndef GL_FRAMEBUFFER_SRGB
#define GL_FRAMEBUFFER_SRGB 0x8DB9
#endif
#ifndef GL_SAMPLES_PASSED
#define GL_SAMPLES_PASSED 0x8914
#endif
#ifndef GL_RGB5
#define GL_RGB5 0x8050
#endif
#ifndef GL_QUERY_NO_WAIT
#define GL_QUERY_NO_WAIT 0x8E14
#endif
#ifndef GL_QUERY_BY_REGION_NO_WAIT
#define GL_QUERY_BY_REGION_NO_WAIT 0x8E16
#endif

namespace {
	struct ShaderRecord {
		GLenum type = 0;
		std::string source;
	};
	struct ProgramRecord {
		std::vector<GLuint> shaders;
		bool failed = false;
		std::string log;
	};
	std::map<GLuint, ShaderRecord> shaders;
	std::map<GLuint, ProgramRecord> programs;
	std::map<GLuint, GLenum> textureFormats; // texture -> effective sized internal format
	std::map<std::pair<GLenum, GLenum>, GLuint> boundTextures; // (unit, target) -> texture
	GLenum activeUnit = GL_TEXTURE0;
	unsigned linkedPrograms = 0;

	GLuint BoundTexture(GLenum target) {
		auto it = boundTextures.find({activeUnit, target});
		return it == boundTextures.end() ? 0 : it->second;
	}

	bool IsDepthFormat(GLenum f) {
		return f == GL_DEPTH_COMPONENT || f == GL_DEPTH_COMPONENT16 || f == GL_DEPTH_COMPONENT24 ||
		       f == GL_DEPTH_COMPONENT32F || f == GL_DEPTH24_STENCIL8 || f == GL_DEPTH32F_STENCIL8;
	}

	// Canonical (format, type) for a sized internal format, used when no pixel data is given.
	bool Canonical(GLenum internal, GLenum &format, GLenum &type) {
		switch (internal) {
			case GL_RGBA8:
			case GL_SRGB8_ALPHA8:
			case GL_RGB5_A1: format = GL_RGBA; type = GL_UNSIGNED_BYTE; return true;
			case GL_RGB8:
			case GL_SRGB8:
			case GL_RGB565: format = GL_RGB; type = GL_UNSIGNED_BYTE; return true;
			case GL_RGB10_A2: format = GL_RGBA; type = GL_UNSIGNED_INT_2_10_10_10_REV; return true;
			case GL_RGBA16F: format = GL_RGBA; type = GL_HALF_FLOAT; return true;
			case GL_RGB16F: format = GL_RGB; type = GL_HALF_FLOAT; return true;
			case GL_RG16F: format = GL_RG; type = GL_HALF_FLOAT; return true;
			case GL_R16F: format = GL_RED; type = GL_HALF_FLOAT; return true;
			case GL_R8: format = GL_RED; type = GL_UNSIGNED_BYTE; return true;
			case GL_RG8: format = GL_RG; type = GL_UNSIGNED_BYTE; return true;
			case GL_DEPTH_COMPONENT24: format = GL_DEPTH_COMPONENT; type = GL_UNSIGNED_INT; return true;
			case GL_DEPTH_COMPONENT16: format = GL_DEPTH_COMPONENT; type = GL_UNSIGNED_SHORT; return true;
			case GL_DEPTH_COMPONENT32F: format = GL_DEPTH_COMPONENT; type = GL_FLOAT; return true;
			default: return false;
		}
	}

	// Maps a desktop (internal, format, type) to a WebGL 2 legal combination.
	// Returns the swizzle kind: 0 = none, 1 = BGRA8 bytes, 2 = BGRA 2_10_10_10_REV words.
	int FixFormat(GLint &internal, GLenum &format, GLenum &type, bool hasData) {
		int swizzle = 0;
		if (format == GL_BGRA) {
			format = GL_RGBA;
			swizzle = type == GL_UNSIGNED_INT_2_10_10_10_REV ? 2 : 1;
		}
		bool isFloat = type == GL_FLOAT || type == GL_HALF_FLOAT;
		switch (internal) {
			case GL_RGBA: if (isFloat) internal = GL_RGBA16F; break;
			case GL_RGB: if (isFloat) internal = GL_RGB16F; break;
			case GL_RG: internal = isFloat ? GL_RG16F : GL_RG8; break;
			case GL_RED: internal = isFloat ? GL_R16F : GL_R8; break;
			case GL_DEPTH_COMPONENT: internal = type == GL_FLOAT ? GL_DEPTH_COMPONENT32F : GL_DEPTH_COMPONENT24; break;
			case GL_RGB5: internal = GL_RGB565; break;
			case GL_RGB16F:
				// RGB16F is never color-renderable in WebGL; render targets need RGBA16F.
				if (!hasData) internal = GL_RGBA16F;
				break;
			case GL_RGB10_A2:
			case GL_RGBA16F:
				if (hasData && type == GL_UNSIGNED_BYTE) internal = GL_RGBA8;
				break;
		}
		if (!hasData) {
			GLenum f, t;
			if (Canonical(internal, f, t)) {
				format = f;
				type = t;
				// 8-bit 2_10_10_10_REV and 5_5_5_1 types are also legal for RGB5_A1
				swizzle = 0;
			}
		}
		return swizzle;
	}

	std::vector<unsigned char> Swizzle(const void *data, size_t pixels, int kind) {
		std::vector<unsigned char> out((const unsigned char *)data, (const unsigned char *)data + pixels * 4);
		if (kind == 1) {
			for (size_t i = 0; i < pixels; ++i) std::swap(out[i * 4], out[i * 4 + 2]);
		} else if (kind == 2) {
			for (size_t i = 0; i < pixels; ++i) {
				uint32_t v;
				std::memcpy(&v, &out[i * 4], 4);
				uint32_t b = v & 0x3ff, r = (v >> 20) & 0x3ff;
				v = (v & 0xc00ffc00u) | r | (b << 20);
				std::memcpy(&out[i * 4], &v, 4);
			}
		}
		return out;
	}

	GLuint CompileStage(GLenum type, const std::vector<std::string> &sources, std::string &log) {
		std::string text = osweb::TranslateShaderStage(
		  type == GL_VERTEX_SHADER ? osweb::ShaderStage::Vertex : osweb::ShaderStage::Fragment, sources);
		GLuint shader = ::glCreateShader(type);
		const GLchar *p = text.c_str();
		::glShaderSource(shader, 1, &p, nullptr);
		::glCompileShader(shader);
		GLint ok = 0, len = 0;
		::glGetShaderiv(shader, GL_COMPILE_STATUS, &ok);
		if (!ok) {
			::glGetShaderiv(shader, GL_INFO_LOG_LENGTH, &len);
			std::string info(len > 0 ? len : 1, '\0');
			::glGetShaderInfoLog(shader, (GLsizei)info.size(), nullptr, &info[0]);
			log += (type == GL_VERTEX_SHADER ? "Translated vertex stage: " : "Translated fragment stage: ");
			log += info.c_str();
			log += "\n--- translated source ---\n" + text.substr(0, 4000);
			::glDeleteShader(shader);
			return 0;
		}
		return shader;
	}
} // namespace

extern "C" {
// Retained for code paths outside SDLGLDevice (none in Sources/Draw use MapBuffer).
void *glMapBuffer(GLenum, GLenum) { return nullptr; }
void glGetQueryObjectui64v(GLuint id, GLenum pname, GLuint64 *value) {
	glGetQueryObjectui64vEXT(id, pname, value);
}

bool osSkipConditionalDraw = false;
void glBeginConditionalRender(GLuint id, GLenum mode) {
	(void)mode;
	// WebGL query results only become available after control returns to the browser, so
	// waiting would block forever. Draw unless a previous result is known to be zero.
	GLuint available = 0, result = 1;
	glGetQueryObjectuiv(id, GL_QUERY_RESULT_AVAILABLE, &available);
	if (available) glGetQueryObjectuiv(id, GL_QUERY_RESULT, &result);
	osSkipConditionalDraw = available && result == 0;
}
void glEndConditionalRender() { osSkipConditionalDraw = false; }

GLuint osweb_glCreateShader(GLenum type) {
	GLuint id = ::glCreateShader(type);
	if (id) shaders[id].type = type;
	return id;
}
void osweb_glShaderSource(GLuint shader, GLsizei count, const GLchar *const *string, const GLint *length) {
	std::string text;
	for (GLsizei i = 0; i < count; ++i)
		text += length && length[i] >= 0 ? std::string(string[i], length[i]) : std::string(string[i]);
	shaders[shader].source = std::move(text);
}
void osweb_glCompileShader(GLuint) {} // compiled per stage when the program is linked
void osweb_glGetShaderiv(GLuint shader, GLenum pname, GLint *params) {
	switch (pname) {
		case GL_COMPILE_STATUS: *params = shaders.count(shader) ? GL_TRUE : GL_FALSE; break;
		case GL_DELETE_STATUS: *params = GL_FALSE; break;
		case GL_SHADER_TYPE: *params = shaders.count(shader) ? (GLint)shaders[shader].type : 0; break;
		case GL_INFO_LOG_LENGTH: *params = 0; break;
		case GL_SHADER_SOURCE_LENGTH: *params = shaders.count(shader) ? (GLint)shaders[shader].source.size() + 1 : 0; break;
		default: ::glGetShaderiv(shader, pname, params);
	}
}
void osweb_glGetShaderInfoLog(GLuint program, GLsizei size, GLsizei *length, GLchar *log) {
	// GLProgram::Validate (upstream) asks for a shader log using a program handle.
	if (programs.count(program)) {
		::glGetProgramInfoLog(program, size, length, log);
		return;
	}
	if (size > 0) log[0] = 0;
	if (length) *length = 0;
}
void osweb_glDeleteShader(GLuint shader) {
	// GL semantics: a deleted shader stays usable while attached to a program (the original
	// deletes shader objects right after attaching them). Keep the recorded source; WebGL object
	// names are never reused by Emscripten, so the record cannot be confused with a new shader.
	::glDeleteShader(shader);
}
void osweb_glAttachShader(GLuint program, GLuint shader) { programs[program].shaders.push_back(shader); }
void osweb_glDetachShader(GLuint program, GLuint shader) {
	auto &list = programs[program].shaders;
	for (auto it = list.begin(); it != list.end(); ++it)
		if (*it == shader) {
			list.erase(it);
			break;
		}
}
void osweb_glLinkProgram(GLuint program) {
	auto &record = programs[program];
	record.failed = false;
	record.log.clear();
	std::vector<std::string> vertex, fragment;
	for (GLuint s : record.shaders) {
		auto it = shaders.find(s);
		if (it == shaders.end()) continue;
		if (it->second.type == GL_VERTEX_SHADER) vertex.push_back(it->second.source);
		else if (it->second.type == GL_FRAGMENT_SHADER) fragment.push_back(it->second.source);
		else {
			record.failed = true;
			record.log = "WebGL 2 has no geometry shaders";
			return;
		}
	}
	GLuint vs = CompileStage(GL_VERTEX_SHADER, vertex, record.log);
	GLuint fs = vs ? CompileStage(GL_FRAGMENT_SHADER, fragment, record.log) : 0;
	if (!vs || !fs) {
		if (vs) ::glDeleteShader(vs);
		record.failed = true;
		return;
	}
	::glAttachShader(program, vs);
	::glAttachShader(program, fs);
	::glLinkProgram(program);
	::glDetachShader(program, vs);
	::glDetachShader(program, fs);
	::glDeleteShader(vs);
	::glDeleteShader(fs);
	GLint ok = 0;
	::glGetProgramiv(program, GL_LINK_STATUS, &ok);
	if (ok) ++linkedPrograms;
}
void osweb_glGetProgramiv(GLuint program, GLenum pname, GLint *params) {
	auto it = programs.find(program);
	if (it != programs.end() && it->second.failed) {
		if (pname == GL_LINK_STATUS || pname == GL_VALIDATE_STATUS) {
			*params = GL_FALSE;
			return;
		}
		if (pname == GL_INFO_LOG_LENGTH) {
			*params = (GLint)it->second.log.size() + 1;
			return;
		}
	}
	::glGetProgramiv(program, pname, params);
}
void osweb_glGetProgramInfoLog(GLuint program, GLsizei size, GLsizei *length, GLchar *log) {
	auto it = programs.find(program);
	if (it != programs.end() && it->second.failed) {
		GLsizei n = size > 0 ? std::min<GLsizei>(size - 1, (GLsizei)it->second.log.size()) : 0;
		if (size > 0) {
			std::memcpy(log, it->second.log.data(), n);
			log[n] = 0;
		}
		if (length) *length = n;
		return;
	}
	::glGetProgramInfoLog(program, size, length, log);
}
void osweb_glDeleteProgram(GLuint program) {
	programs.erase(program);
	::glDeleteProgram(program);
}
void osweb_glValidateProgram(GLuint program) { ::glValidateProgram(program); }
GLint osweb_glGetUniformLocation(GLuint program, const GLchar *name) {
	return ::glGetUniformLocation(program, osweb::MapShaderIdentifier(name).c_str());
}
GLint osweb_glGetAttribLocation(GLuint program, const GLchar *name) {
	return ::glGetAttribLocation(program, osweb::MapShaderIdentifier(name).c_str());
}
void osweb_glBindAttribLocation(GLuint program, GLuint index, const GLchar *name) {
	::glBindAttribLocation(program, index, osweb::MapShaderIdentifier(name).c_str());
}

static bool UnsupportedCap(GLenum cap) {
	return cap == GL_TEXTURE_2D || cap == GL_MULTISAMPLE || cap == GL_FRAMEBUFFER_SRGB;
}
void osweb_glEnable(GLenum cap) {
	if (!UnsupportedCap(cap)) ::glEnable(cap);
}
void osweb_glDisable(GLenum cap) {
	if (!UnsupportedCap(cap)) ::glDisable(cap);
}

void osweb_glDrawArrays(GLenum mode, GLint first, GLsizei count) {
	if (!osSkipConditionalDraw) ::glDrawArrays(mode, first, count);
}
void osweb_glDrawElements(GLenum mode, GLsizei count, GLenum type, const void *indices) {
	if (!osSkipConditionalDraw) ::glDrawElements(mode, count, type, indices);
}
void osweb_glDrawArraysInstanced(GLenum mode, GLint first, GLsizei count, GLsizei instances) {
	if (!osSkipConditionalDraw) ::glDrawArraysInstanced(mode, first, count, instances);
}
void osweb_glDrawElementsInstanced(GLenum mode, GLsizei count, GLenum type, const void *indices,
                                   GLsizei instances) {
	if (!osSkipConditionalDraw) ::glDrawElementsInstanced(mode, count, type, indices, instances);
}

void osweb_glActiveTexture(GLenum unit) {
	activeUnit = unit;
	::glActiveTexture(unit);
}
void osweb_glBindTexture(GLenum target, GLuint texture) {
	boundTextures[{activeUnit, target}] = texture;
	::glBindTexture(target, texture);
}
void osweb_glDeleteTextures(GLsizei n, const GLuint *textures) {
	for (GLsizei i = 0; i < n; ++i) {
		textureFormats.erase(textures[i]);
		for (auto &b : boundTextures)
			if (b.second == textures[i]) b.second = 0;
	}
	::glDeleteTextures(n, textures);
}
void osweb_glTexImage2D(GLenum target, GLint level, GLint internal, GLsizei w, GLsizei h, GLint border,
                        GLenum format, GLenum type, const void *data) {
	int swizzle = FixFormat(internal, format, type, data != nullptr);
	if (level == 0) textureFormats[BoundTexture(target)] = internal;
	if (data && swizzle) {
		auto pixels = Swizzle(data, size_t(w) * h, swizzle);
		::glTexImage2D(target, level, internal, w, h, border, format, type, pixels.data());
	} else {
		::glTexImage2D(target, level, internal, w, h, border, format, type, data);
	}
}
void osweb_glTexImage3D(GLenum target, GLint level, GLint internal, GLsizei w, GLsizei h, GLsizei d,
                        GLint border, GLenum format, GLenum type, const void *data) {
	int swizzle = FixFormat(internal, format, type, data != nullptr);
	if (level == 0) textureFormats[BoundTexture(target)] = internal;
	if (data && swizzle) {
		auto pixels = Swizzle(data, size_t(w) * h * d, swizzle);
		::glTexImage3D(target, level, internal, w, h, d, border, format, type, pixels.data());
	} else {
		::glTexImage3D(target, level, internal, w, h, d, border, format, type, data);
	}
}
static void FixSubFormat(GLenum target, GLenum &format, GLenum &type, int &swizzle) {
	swizzle = 0;
	if (format == GL_BGRA) {
		format = GL_RGBA;
		swizzle = type == GL_UNSIGNED_INT_2_10_10_10_REV ? 2 : 1;
	}
	// A float texture allocated without data uses HALF_FLOAT canonically; FLOAT data is legal too.
	(void)target;
}
void osweb_glTexSubImage2D(GLenum target, GLint level, GLint x, GLint y, GLsizei w, GLsizei h,
                           GLenum format, GLenum type, const void *data) {
	int swizzle;
	FixSubFormat(target, format, type, swizzle);
	if (data && swizzle) {
		auto pixels = Swizzle(data, size_t(w) * h, swizzle);
		::glTexSubImage2D(target, level, x, y, w, h, format, type, pixels.data());
	} else {
		::glTexSubImage2D(target, level, x, y, w, h, format, type, data);
	}
}
void osweb_glTexSubImage3D(GLenum target, GLint level, GLint x, GLint y, GLint z, GLsizei w, GLsizei h,
                           GLsizei d, GLenum format, GLenum type, const void *data) {
	int swizzle;
	FixSubFormat(target, format, type, swizzle);
	if (data && swizzle) {
		auto pixels = Swizzle(data, size_t(w) * h * d, swizzle);
		::glTexSubImage3D(target, level, x, y, z, w, h, d, format, type, pixels.data());
	} else {
		::glTexSubImage3D(target, level, x, y, z, w, h, d, format, type, data);
	}
}
void osweb_glCopyTexSubImage2D(GLenum target, GLint level, GLint xoff, GLint yoff, GLint x, GLint y,
                               GLsizei w, GLsizei h) {
	GLuint texture = BoundTexture(target);
	auto it = textureFormats.find(texture);
	if (texture && it != textureFormats.end() && IsDepthFormat(it->second)) {
		// WebGL forbids copying depth with CopyTexSubImage2D; a depth blit is equivalent.
		static GLuint scratch = 0;
		if (!scratch) glGenFramebuffers(1, &scratch);
		GLint drawFb = 0;
		glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &drawFb);
		glBindFramebuffer(GL_DRAW_FRAMEBUFFER, scratch);
		glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, target, texture, level);
		glBlitFramebuffer(x, y, x + w, y + h, xoff, yoff, xoff + w, yoff + h, GL_DEPTH_BUFFER_BIT, GL_NEAREST);
		glFramebufferTexture2D(GL_DRAW_FRAMEBUFFER, GL_DEPTH_ATTACHMENT, target, 0, 0);
		glBindFramebuffer(GL_DRAW_FRAMEBUFFER, drawFb);
		return;
	}
	::glCopyTexSubImage2D(target, level, xoff, yoff, x, y, w, h);
}
static GLenum RenderbufferFormat(GLenum internal) {
	switch (internal) {
		case GL_RGB5: return GL_RGB565;
		case GL_RGB16F: return GL_RGBA16F;
		case GL_DEPTH_COMPONENT: return GL_DEPTH_COMPONENT24;
		case GL_RGBA: return GL_RGBA8;
		case GL_RGB: return GL_RGB8;
		default: return internal;
	}
}
void osweb_glRenderbufferStorage(GLenum target, GLenum internal, GLsizei w, GLsizei h) {
	::glRenderbufferStorage(target, RenderbufferFormat(internal), w, h);
}
void osweb_glRenderbufferStorageMultisample(GLenum target, GLsizei samples, GLenum internal, GLsizei w,
                                            GLsizei h) {
	internal = RenderbufferFormat(internal);
	GLint maxSamples = 0;
	glGetInternalformativ(GL_RENDERBUFFER, internal, GL_SAMPLES, 1, &maxSamples);
	if (samples > maxSamples) {
		std::printf("WebGL: %d samples requested for format 0x%04x; using %d\n", samples, internal, maxSamples);
		samples = maxSamples;
	}
	::glRenderbufferStorageMultisample(target, samples, internal, w, h);
}
void osweb_glBeginQuery(GLenum target, GLuint id) {
	::glBeginQuery(target == GL_SAMPLES_PASSED ? GL_ANY_SAMPLES_PASSED : target, id);
}
void osweb_glEndQuery(GLenum target) {
	::glEndQuery(target == GL_SAMPLES_PASSED ? GL_ANY_SAMPLES_PASSED : target);
}

unsigned osweb_linked_program_count() { return linkedPrograms; }

// The client loop runs on a pthread that never yields to its event loop, so the OffscreenCanvas
// would never present implicitly. Each swap hands the finished frame to the page as an
// ImageBitmap (browser.js draws it); at most two frames are in flight, which paces rendering
// to the display like the desktop's vsync.
int osweb_frames_in_flight = 0;
EM_JS(int, osweb_post_frame, (int *counter), {
	var ctx = GL.currentContext;
	if (!ctx || typeof OffscreenCanvas === 'undefined' || !(ctx.GLctx.canvas instanceof OffscreenCanvas)) {
		// OFFSCREEN_FRAMEBUFFER fallback: the main thread presents the canvas itself.
		if (!Module['osViewHidden']) { Module['osViewHidden'] = true; postMessage({osHideView: 1}); }
		return 0;
	}
	var bitmap = ctx.GLctx.canvas.transferToImageBitmap();
	postMessage({osFrame: bitmap, osCounter: counter}, [bitmap]);
	return 1;
});
static int maxFramesInFlight = 2;
int osweb_set_swap_interval(int interval) {
	// r_vsync: pace to the display (frames shown per refresh) or let frames queue a little more.
	maxFramesInFlight = interval != 0 ? 2 : 4;
	return 0;
}
void *osweb_create_gl_context() {
	EmscriptenWebGLContextAttributes attrs;
	emscripten_webgl_init_context_attributes(&attrs);
	attrs.majorVersion = 2;
	attrs.minorVersion = 0;
	attrs.alpha = false;      // desktop default framebuffer is opaque
	attrs.depth = false;      // SDL_GL_DEPTH_SIZE 0: the renderer uses its own framebuffers
	attrs.stencil = false;
	attrs.antialias = false;  // MSAA is done by the renderer's multisampled renderbuffers
	attrs.premultipliedAlpha = false;
	attrs.preserveDrawingBuffer = false;
	attrs.powerPreference = EM_WEBGL_POWER_PREFERENCE_HIGH_PERFORMANCE;
	attrs.enableExtensionsByDefault = true;
	// With an OffscreenCanvas owned by this thread, draw straight into its backbuffer (presented
	// by osweb_present). Without one, fall back to a context proxied to the page thread, which
	// requires Emscripten's offscreen back buffer.
	bool ownsCanvas = EM_ASM_INT({ return !!(typeof GL !== 'undefined' && GL.offscreenCanvases && GL.offscreenCanvases['canvas']); });
	attrs.proxyContextToMainThread = ownsCanvas ? EMSCRIPTEN_WEBGL_CONTEXT_PROXY_DISALLOW : EMSCRIPTEN_WEBGL_CONTEXT_PROXY_ALWAYS;
	attrs.renderViaOffscreenBackBuffer = !ownsCanvas;
	std::printf("WebGL 2 context: %s\n", ownsCanvas ? "OffscreenCanvas on the client thread" : "proxied to the page thread (fallback)");
	EMSCRIPTEN_WEBGL_CONTEXT_HANDLE ctx = emscripten_webgl_create_context("#canvas", &attrs);
	if (ctx <= 0) {
		std::printf("WebGL 2 context creation failed (%d)\n", (int)ctx);
		return nullptr;
	}
	emscripten_webgl_make_context_current(ctx);
	for (const char *ext : {"EXT_color_buffer_float", "EXT_color_buffer_half_float", "OES_texture_float_linear",
	                        "EXT_float_blend", "EXT_texture_filter_anisotropic", "EXT_disjoint_timer_query_webgl2"})
		std::printf("WebGL extension %s: %s\n", ext, emscripten_webgl_enable_extension(ctx, ext) ? "yes" : "no");
	return (void *)(intptr_t)ctx;
}
void osweb_destroy_gl_context(void *ctx) {
	if (ctx) emscripten_webgl_destroy_context((EMSCRIPTEN_WEBGL_CONTEXT_HANDLE)(intptr_t)ctx);
}
void osweb_present() {
	__atomic_add_fetch(&osweb_frames_in_flight, 1, __ATOMIC_SEQ_CST);
	if (!osweb_post_frame(&osweb_frames_in_flight)) {
		__atomic_sub_fetch(&osweb_frames_in_flight, 1, __ATOMIC_SEQ_CST);
		return;
	}
	// The wait is capped by time, not by a count of sleeps: a sleep can last far longer than asked
	// (200 x usleep(500) took ~3 s), and whenever the page stops showing frames (requestAnimationFrame
	// paused or stalled) every frame waited that long. ENet is serviced once per frame, so the map
	// download ("Loading snapshot") was acknowledged every ~3 s and crawled at ~1 KB/s.
	const double deadline = emscripten_get_now() + 50.0;
	while (__atomic_load_n(&osweb_frames_in_flight, __ATOMIC_SEQ_CST) > maxFramesInFlight &&
	       emscripten_get_now() < deadline) {
		emscripten_current_thread_process_queued_calls();
		usleep(500);
	}
}
}
