// Offline check: translate and compile/link every original OpenSpades GLSL program for GLSL ES 3.00
// with a real GLES 3 driver (Mesa, surfaceless EGL). No window, browser or playtesting involved.
// Mirrors GLProgramManager::CreateProgram/CreateShader and the *shadow*/*dlight*/*shadowmap*
// expansions for every combination of the settings those files depend on.
#include "../ShaderTranslator.h"

#include <EGL/egl.h>
#include <EGL/eglext.h>
#include <GLES3/gl3.h>

#include <cstdio>
#include <filesystem>
#include <fstream>
#include <functional>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace fs = std::filesystem;
static fs::path root;

static std::string ReadFile(const std::string &name) {
	std::ifstream f(root / name, std::ios::binary);
	if (!f) throw std::runtime_error("missing " + name);
	std::stringstream s;
	s << f.rdbuf();
	return s.str();
}

struct Settings {
	bool hdr, fog, ssao, modelShadows, sparse;
	int radiosity;
};

static std::string Defines(const Settings &s) {
	std::string d;
	d += s.hdr ? "#define USE_HDR 1\n#define LINEAR_FRAMEBUFFER 1\n"
	           : "#define USE_HDR 0\n#define LINEAR_FRAMEBUFFER 0\n";
	d += s.fog ? "#define USE_VOLUMETRIC_FOG 1\n" : "#define USE_VOLUMETRIC_FOG 0\n";
	d += s.ssao ? "#define USE_SSAO 1\n" : "#define USE_SSAO 0\n";
	d += "#define USE_RADIOSITY " + std::to_string(s.radiosity >= 2 ? 2 : s.radiosity) + "\n";
	return d;
}

static std::vector<std::string> Expand(const std::string &line, const Settings &s) {
	std::vector<std::string> v;
	if (line == "*shadow*" || line == "*shadow-lite*" || line == "*shadow-variance*") {
		bool variance = line == "*shadow-variance*", skipSSAO = line == "*shadow-lite*";
		v.push_back(skipSSAO ? "Shaders/Shadow/CommonNoSSAO.fs" : "Shaders/Shadow/Common.fs");
		v.push_back("Shaders/Shadow/Common.vs");
		v.push_back(variance ? "Shaders/Shadow/MapVariance.fs" : "Shaders/Shadow/Map.fs");
		v.push_back(variance ? "Shaders/Shadow/MapVariance.vs" : "Shaders/Shadow/Map.vs");
		const char *m = s.modelShadows ? (s.sparse ? "ModelSparse" : "Model") : "ModelNull";
		v.push_back(std::string("Shaders/Shadow/") + m + ".fs");
		v.push_back(std::string("Shaders/Shadow/") + m + ".vs");
		const char *r = s.radiosity ? "MapRadiosity" : "MapRadiosityNull";
		v.push_back(std::string("Shaders/Shadow/") + r + ".fs");
		v.push_back(std::string("Shaders/Shadow/") + r + ".vs");
	} else if (line == "*dlight*") {
		v = {"Shaders/DynamicLight/Common.fs", "Shaders/DynamicLight/Common.vs",
		     "Shaders/DynamicLight/MapNull.fs", "Shaders/DynamicLight/MapNull.vs"};
	} else if (line == "*shadowmap*") {
		v = {"Shaders/ShadowMap/Common.fs", "Shaders/ShadowMap/Common.vs",
		     "Shaders/ShadowMap/Basic.fs", "Shaders/ShadowMap/Basic.vs"};
	} else if (line[0] == '*') {
		throw std::runtime_error("unknown special shader " + line);
	} else if (line[0] != '#') {
		v.push_back(line);
	}
	return v;
}

static std::string Trim(std::string s) {
	while (!s.empty() && isspace((unsigned char)s.back())) s.pop_back();
	size_t a = 0;
	while (a < s.size() && isspace((unsigned char)s[a])) ++a;
	return s.substr(a);
}

static bool Compile(GLuint sh, const std::string &src, std::string &log) {
	const char *p = src.c_str();
	glShaderSource(sh, 1, &p, nullptr);
	glCompileShader(sh);
	GLint ok = 0, len = 0;
	glGetShaderiv(sh, GL_COMPILE_STATUS, &ok);
	glGetShaderiv(sh, GL_INFO_LOG_LENGTH, &len);
	log.assign(len > 0 ? len : 0, 0);
	if (len > 0) glGetShaderInfoLog(sh, len, nullptr, &log[0]);
	return ok != 0;
}

int main(int argc, char **argv) {
	root = argc > 1 ? argv[1] : "../resources";
	auto getDisplay = (PFNEGLGETPLATFORMDISPLAYEXTPROC)eglGetProcAddress("eglGetPlatformDisplayEXT");
	EGLDisplay dpy = getDisplay ? getDisplay(EGL_PLATFORM_SURFACELESS_MESA, EGL_DEFAULT_DISPLAY, nullptr)
	                            : eglGetDisplay(EGL_DEFAULT_DISPLAY);
	if (!eglInitialize(dpy, nullptr, nullptr)) return fprintf(stderr, "eglInitialize failed\n"), 2;
	eglBindAPI(EGL_OPENGL_ES_API);
	EGLint cfgAttr[] = {EGL_RENDERABLE_TYPE, EGL_OPENGL_ES3_BIT, EGL_NONE};
	EGLConfig cfg;
	EGLint n = 0;
	eglChooseConfig(dpy, cfgAttr, &cfg, 1, &n);
	EGLint ctxAttr[] = {EGL_CONTEXT_MAJOR_VERSION, 3, EGL_CONTEXT_MINOR_VERSION, 0, EGL_NONE};
	EGLContext ctx = eglCreateContext(dpy, n ? cfg : EGL_NO_CONFIG_KHR, EGL_NO_CONTEXT, ctxAttr);
	if (!ctx || !eglMakeCurrent(dpy, EGL_NO_SURFACE, EGL_NO_SURFACE, ctx))
		return fprintf(stderr, "could not create a surfaceless GLES 3 context\n"), 2;
	printf("Validator driver: %s / %s\n", glGetString(GL_RENDERER), glGetString(GL_SHADING_LANGUAGE_VERSION));

	{
		// Negative control: untranslated desktop constructs must be rejected by this driver,
		// otherwise a passing run would prove nothing.
		std::string log;
		GLuint sh = glCreateShader(GL_FRAGMENT_SHADER);
		bool accepted = Compile(sh, "#version 300 es\nprecision highp float;\nvarying vec2 c;\n"
		                            "uniform sampler2D t;\nvoid main(){gl_FragColor=texture2D(t,c);}\n", log);
		glDeleteShader(sh);
		sh = glCreateShader(GL_FRAGMENT_SHADER);
		bool conv = Compile(sh, "#version 300 es\nprecision highp float;\nout vec4 o;\n"
		                        "void main(){float x = 1; o=vec4(x);}\n", log);
		glDeleteShader(sh);
		if (accepted || conv) return fprintf(stderr, "driver accepted invalid ESSL; validation meaningless\n"), 2;
		printf("Negative controls rejected as expected\n");
	}

	std::vector<std::string> programs;
	for (auto &e : fs::recursive_directory_iterator(root / "Shaders"))
		if (e.path().extension() == ".program")
			programs.push_back(fs::relative(e.path(), root).generic_string());
	std::sort(programs.begin(), programs.end());

	std::map<std::string, bool> cache; // stage sources -> link ok
	int failures = 0, links = 0;
	std::set<std::string> failedPrograms;
	for (const auto &program : programs) {
		std::set<std::string> combosFailed;
		for (int bits = 0; bits < 96; ++bits) {
			Settings s{bool(bits & 1), bool(bits & 2), bool(bits & 4), bool(bits & 8), bool(bits & 16),
			           (bits >> 5) % 3};
			std::vector<std::string> vs, fsrc;
			std::istringstream lines(ReadFile(program));
			std::string line;
			while (std::getline(lines, line)) {
				line = Trim(line);
				if (line.empty()) break; // matches GLProgramManager
				for (auto &file : Expand(line, s)) {
					std::string src = Defines(s) + ReadFile(file);
					if (file.find(".fs") != std::string::npos) fsrc.push_back(src);
					else if (file.find(".vs") != std::string::npos) vs.push_back(src);
					else throw std::runtime_error("unknown stage " + file);
				}
			}
			std::string v = osweb::TranslateShaderStage(osweb::ShaderStage::Vertex, vs);
			std::string f = osweb::TranslateShaderStage(osweb::ShaderStage::Fragment, fsrc);
			auto key = v + '\0' + f;
			if (cache.count(key)) continue;
			std::string log;
			GLuint vsh = glCreateShader(GL_VERTEX_SHADER), fsh = glCreateShader(GL_FRAGMENT_SHADER);
			bool ok = Compile(vsh, v, log);
			std::string what = "vertex";
			if (ok) ok = Compile(fsh, f, log), what = "fragment";
			if (ok) {
				GLuint p = glCreateProgram();
				glAttachShader(p, vsh);
				glAttachShader(p, fsh);
				glLinkProgram(p);
				GLint st = 0, len = 0;
				glGetProgramiv(p, GL_LINK_STATUS, &st);
				glGetProgramiv(p, GL_INFO_LOG_LENGTH, &len);
				ok = st != 0;
				what = "link";
				if (!ok && len > 0) {
					log.assign(len, 0);
					glGetProgramInfoLog(p, len, nullptr, &log[0]);
				}
				glDeleteProgram(p);
			}
			glDeleteShader(vsh);
			glDeleteShader(fsh);
			++links;
			cache[key] = ok;
			if (!ok) {
				++failures;
				failedPrograms.insert(program);
				std::string first = log.substr(0, log.find('\n', log.find('\n') + 1));
				if (combosFailed.insert(what + first).second) {
					printf("FAIL %s [%s] hdr=%d fog=%d ssao=%d model=%d sparse=%d rad=%d\n  %s\n",
					       program.c_str(), what.c_str(), s.hdr, s.fog, s.ssao, s.modelShadows,
					       s.sparse, s.radiosity, log.substr(0, 600).c_str());
					if (getenv("DUMP")) {
						std::ofstream("/tmp/fail.vs") << v;
						std::ofstream("/tmp/fail.fs") << f;
					}
				}
			}
		}
	}
	printf("%zu programs, %d distinct translated variants compiled+linked, %d failed (%zu programs)\n",
	       programs.size(), links, failures, failedPrograms.size());
	return failures ? 1 : 0;
}
