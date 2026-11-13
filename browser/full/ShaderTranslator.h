// Translates OpenSpades' desktop GLSL (multiple shader objects per stage, GLSL 1.10/1.20 style)
// into one GLSL ES 3.00 source per stage for WebGL 2. Portable C++: also built natively by
// tools/validate_shaders.cpp to compile every original program with a real GLES 3 driver.
#pragma once
#include <string>
#include <vector>

namespace osweb {
	enum class ShaderStage { Vertex, Fragment };

	// Merges the sources of all shader objects attached to one stage, in attachment order.
	std::string TranslateShaderStage(ShaderStage stage, const std::vector<std::string> &sources);

	// Identifiers that are reserved in GLSL ES 3.00 are renamed in the translated source.
	// Uniform/attribute queries from the original renderer must use the renamed spelling.
	std::string MapShaderIdentifier(const std::string &name);
} // namespace osweb
