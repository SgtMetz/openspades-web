#include "ShaderTranslator.h"

#include <cctype>
#include <set>
#include <sstream>
#include <unordered_map>

namespace osweb {
	namespace {
		bool IsIdentStart(char c) { return std::isalpha((unsigned char)c) || c == '_'; }
		bool IsIdent(char c) { return std::isalnum((unsigned char)c) || c == '_'; }

		// Words that were legal identifiers in desktop GLSL 1.x but are reserved in ESSL 3.00.
		const std::set<std::string> &ReservedWords() {
			static const std::set<std::string> words{
			  "texture", "sample",   "input",  "output",   "filter",        "flat",
			  "smooth",  "layout",   "packed", "common",   "partition",     "active",
			  "buffer",  "shared",   "resource", "patch",  "noperspective", "superp",
			  "sampler", "centroid", "invariant", "subroutine", "image",   "atomic_uint"};
			return words;
		}

		// Replaces comments with whitespace (newlines are kept so line structure is unchanged).
		std::string StripComments(const std::string &src) {
			std::string out;
			out.reserve(src.size());
			for (size_t i = 0; i < src.size(); ++i) {
				if (src[i] == '/' && i + 1 < src.size() && src[i + 1] == '/') {
					while (i < src.size() && src[i] != '\n') ++i;
					if (i < src.size()) out += '\n';
				} else if (src[i] == '/' && i + 1 < src.size() && src[i + 1] == '*') {
					i += 2;
					while (i + 1 < src.size() && !(src[i] == '*' && src[i + 1] == '/')) {
						if (src[i] == '\n') out += '\n';
						++i;
					}
					++i;
					out += ' ';
				} else if (src[i] == '\r') {
					// normalize line endings
				} else {
					out += src[i];
				}
			}
			return out;
		}

		std::string TranslateTokens(ShaderStage stage, const std::string &src) {
			static const std::unordered_map<std::string, std::string> simple{
			  {"texture2D", "texture"},           {"texture3D", "texture"},
			  {"textureCube", "texture"},         {"texture2DArray", "texture"},
			  {"texture1D", "texture"},           {"texture2DLod", "textureLod"},
			  {"texture3DLod", "textureLod"},     {"texture2DArrayLod", "textureLod"},
			  {"textureCubeLod", "textureLod"},   {"texture2DProj", "textureProj"},
			  {"texture2DProjLod", "textureProjLod"}, {"texture2DGrad", "textureGrad"},
			  {"gl_FragColor", "os_FragColor"}};
			std::string out;
			out.reserve(src.size() + 256);
			std::vector<int> closeExtra; // paren depths at which an extra ')' must be emitted
			int paren = 0;
			bool pendingShadowCall = false;
			for (size_t i = 0; i < src.size();) {
				char c = src[i];
				if (IsIdentStart(c)) {
					size_t j = i;
					while (j < src.size() && IsIdent(src[j])) ++j;
					std::string word = src.substr(i, j - i);
					i = j;
					auto it = simple.find(word);
					if (it != simple.end()) {
						out += it->second;
					} else if (word == "attribute") {
						out += stage == ShaderStage::Vertex ? "in" : "attribute";
					} else if (word == "varying") {
						out += stage == ShaderStage::Vertex ? "out" : "in";
					} else if (word == "shadow2D" || word == "shadow2DProj") {
						// shadow2D returned vec4 in GLSL 1.x; texture(sampler2DShadow) returns float.
						out += word == "shadow2D" ? "vec4(texture" : "vec4(textureProj";
						pendingShadowCall = true;
						continue;
					} else if (ReservedWords().count(word)) {
						out += "os_r_" + word;
					} else {
						out += word;
					}
					pendingShadowCall = false;
					continue;
				}
				if (std::isdigit((unsigned char)c)) {
					// numeric literal (keep suffixes like 1.e-3, 2u)
					size_t j = i;
					while (j < src.size() &&
					       (IsIdent(src[j]) || src[j] == '.' ||
					        ((src[j] == '-' || src[j] == '+') && (src[j - 1] == 'e' || src[j - 1] == 'E'))))
						++j;
					out.append(src, i, j - i);
					i = j;
					pendingShadowCall = false;
					continue;
				}
				if (c == '(') {
					++paren;
					if (pendingShadowCall) closeExtra.push_back(paren);
					pendingShadowCall = false;
				} else if (c == ')') {
					out += ')';
					if (!closeExtra.empty() && closeExtra.back() == paren) {
						out += ')';
						closeExtra.pop_back();
					}
					--paren;
					++i;
					continue;
				} else if (!std::isspace((unsigned char)c)) {
					pendingShadowCall = false;
				}
				out += c;
				++i;
			}
			return out;
		}

		std::string Trim(const std::string &s) {
			size_t a = s.find_first_not_of(" \t");
			if (a == std::string::npos) return std::string();
			size_t b = s.find_last_not_of(" \t");
			return s.substr(a, b - a + 1);
		}

		std::string NormalizeSpaces(const std::string &s) {
			std::string out;
			bool space = false;
			for (char c : Trim(s)) {
				if (c == ' ' || c == '\t') {
					space = true;
					continue;
				}
				if (space && !out.empty()) out += ' ';
				space = false;
				out += c;
			}
			return out;
		}

		bool StartsWithWord(const std::string &s, const char *word) {
			size_t n = std::char_traits<char>::length(word);
			return s.compare(0, n, word) == 0 && (s.size() == n || !IsIdent(s[n]));
		}

		std::string DirectiveName(const std::string &line) {
			std::string t = Trim(line);
			if (t.empty() || t[0] != '#') return std::string();
			size_t i = 1;
			while (i < t.size() && (t[i] == ' ' || t[i] == '\t')) ++i;
			size_t j = i;
			while (j < t.size() && IsIdent(t[j])) ++j;
			return t.substr(i, j - i);
		}
	} // namespace

	std::string MapShaderIdentifier(const std::string &name) {
		return ReservedWords().count(name) ? "os_r_" + name : name;
	}

	std::string TranslateShaderStage(ShaderStage stage, const std::vector<std::string> &sources) {
		std::ostringstream out;
		out << "#version 300 es\n"
		       "precision highp float;\n"
		       "precision highp int;\n"
		       "precision highp sampler2D;\n"
		       "precision highp sampler3D;\n"
		       "precision highp sampler2DShadow;\n"
		       "precision highp sampler2DArray;\n"
		       "precision highp samplerCube;\n";
		if (stage == ShaderStage::Fragment) out << "layout(location = 0) out highp vec4 os_FragColor;\n";

		// Global uniform/in/out declarations are hoisted above all code. Each source object declares
		// its own varyings between functions; some mobile drivers (Samsung Xclipse via Firefox) then
		// reject the merged stage with "undeclared identifier" on varyings assigned in later units.
		std::ostringstream body;
		std::set<std::string> globals; // depth-0 global declarations already emitted
		for (size_t index = 0; index < sources.size(); ++index) {
			std::string text = TranslateTokens(stage, StripComments(sources[index]));
			std::istringstream lines(text);
			std::string line;
			int ppDepth = 0, braces = 0, parens = 0;
			body << "#line 1 " << index + 1 << "\n";
			while (std::getline(lines, line)) {
				std::string directive = DirectiveName(line);
				if (directive == "version" || directive == "extension") {
					body << "\n";
					continue;
				}
				if (directive == "if" || directive == "ifdef" || directive == "ifndef") ++ppDepth;
				if (directive == "endif") --ppDepth;

				bool drop = false;
				if (directive.empty() && ppDepth == 0 && braces == 0 && parens == 0) {
					std::string t = NormalizeSpaces(line);
					if ((StartsWithWord(t, "uniform") || StartsWithWord(t, "in") ||
					     StartsWithWord(t, "out")) &&
					    !t.empty() && t.back() == ';' && t.find('(') == std::string::npos) {
						if (globals.insert(t).second) out << t << "\n";
						drop = true;
					}
				}
				if (directive.empty()) {
					for (char c : line) {
						if (c == '{') ++braces;
						if (c == '}') --braces;
						if (c == '(') ++parens;
						if (c == ')') --parens;
					}
				}
				body << (drop ? std::string() : line) << "\n";
			}
		}
		out << body.str();
		return out.str();
	}
} // namespace osweb
