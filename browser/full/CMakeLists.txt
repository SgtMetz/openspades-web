cmake_minimum_required(VERSION 3.16)
project(OpenSpadesFullBrowser LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(SRC "${CMAKE_CURRENT_SOURCE_DIR}/generated")
file(GLOB CORE ${SRC}/Core/*.cpp ${SRC}/Core/*.c)
list(FILTER CORE EXCLUDE REGEX "/(OpusAudioStream|AudioStream)\\.cpp$")
file(GLOB CLIENT ${SRC}/Client/*.cpp)
file(GLOB DRAW ${SRC}/Draw/*.cpp)
file(GLOB GUI ${SRC}/Gui/*.cpp)
list(FILTER GUI EXCLUDE REGEX "/(Main|SplashWindow)\\.cpp$")
file(GLOB BINDINGS ${SRC}/ScriptBindings/*.cpp)
file(GLOB SCRIPT ${SRC}/AngelScript/source/*.cpp ${SRC}/AngelScript/addons/*.cpp)
file(GLOB SUPPORT ${SRC}/json/*.cpp ${SRC}/unzip/*.c ${SRC}/kiss_fft130/*.c)
file(GLOB ENET ${SRC}/ENet/*.c)
list(FILTER ENET EXCLUDE REGEX "/(unix|win32)\\.c$")
add_executable(full-client ${CORE} ${CLIENT} ${DRAW} ${GUI} ${BINDINGS} ${SCRIPT} ${SUPPORT} ${ENET}
  ${SRC}/Audio/NullDevice.cpp main.cpp verify.cpp BrowserAudio.cpp http.cpp enet_full.c WebGLCompat.cpp ShaderTranslator.cpp BrowserPlatform.cpp)
target_include_directories(full-client PRIVATE . vendor ${SRC} ${SRC}/json/include ${SRC}/ENet/include ${SRC}/AngelScript/include)
target_compile_definitions(full-client PRIVATE NDEBUG AS_MAX_PORTABILITY HAS_SOCKLEN_T=1)
set(PORTS -sUSE_SDL=2 -sUSE_SDL_IMAGE=2 -sUSE_ZLIB=1 -sUSE_FREETYPE=1 -sUSE_LIBPNG=1 -sUSE_LIBJPEG=1 "-sSDL2_IMAGE_FORMATS=['png','jpg']")
target_compile_options(full-client PRIVATE -O2 -pthread -fexceptions ${PORTS} -Wno-deprecated-declarations -Wno-unused-value -Wno-pointer-bool-conversion -Wno-exceptions)
target_link_options(full-client PRIVATE -O2 -pthread -fexceptions ${PORTS}
  "--pre-js" "${CMAKE_CURRENT_SOURCE_DIR}/browser.js" -lidbfs.js
  -sPTHREAD_POOL_SIZE=8 -sPROXY_TO_PTHREAD=1 -sOFFSCREENCANVAS_SUPPORT=1 -sOFFSCREEN_FRAMEBUFFER=1 -sFETCH=1
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=268435456 -sMAXIMUM_MEMORY=2147483648 -sSTACK_SIZE=4194304
  -sFULL_ES2=1 -sFULL_ES3=1 -sMAX_WEBGL_VERSION=2 -sGL_ENABLE_GET_PROC_ADDRESS=1
  -sASSERTIONS=1 -sEXIT_RUNTIME=1 -sENVIRONMENT=web,worker,node -sFORCE_FILESYSTEM=1
  "--preload-file" "${CMAKE_CURRENT_SOURCE_DIR}/resources@/Resources")
set_target_properties(full-client PROPERTIES SUFFIX ".js" RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/../dist/full"
  LINK_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/browser.js")  # --pre-js is bundled at link time
