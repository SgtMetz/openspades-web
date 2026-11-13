cmake_minimum_required(VERSION 3.16)
project(OpenSpadesBrowser LANGUAGES C CXX)
set(CMAKE_CXX_STANDARD 17)
set(SRC "${CMAKE_CURRENT_SOURCE_DIR}/../openspades/Sources")

# Original ENet with a browser socket layer (native/enet_browser.c) instead of unix.c.
add_library(enet STATIC
  native/enet_browser.c
  ${SRC}/ENet/callbacks.c ${SRC}/ENet/compress.c ${SRC}/ENet/host.c ${SRC}/ENet/list.c
  ${SRC}/ENet/packet.c ${SRC}/ENet/peer.c ${SRC}/ENet/protocol.c)
target_include_directories(enet PUBLIC ${SRC}/ENet/include)
target_compile_options(enet PRIVATE -O2 -DHAS_SOCKLEN_T=1)

add_executable(openspades
  native/bridge.cpp native/net.cpp native/platform.cpp
  ${SRC}/Client/World.cpp ${SRC}/Client/Player.cpp ${SRC}/Client/Weapon.cpp
  ${SRC}/Client/GameMap.cpp ${SRC}/Client/GameMapWrapper.cpp ${SRC}/Client/Grenade.cpp
  ${SRC}/Client/GameProperties.cpp ${SRC}/Core/CP437.cpp
  ${SRC}/Core/Math.cpp ${SRC}/Core/ThreadLocalStorage.cpp ${SRC}/Core/RefCountedObject.cpp
  ${SRC}/Core/IStream.cpp)
target_include_directories(openspades PRIVATE ${SRC})
target_link_libraries(openspades PRIVATE enet)
target_compile_options(openspades PRIVATE -O2 -DNDEBUG -fexceptions -Wno-deprecated-declarations -sUSE_ZLIB=1)
target_link_options(openspades PRIVATE -O2 -fexceptions -sUSE_ZLIB=1
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sEXPORT_NAME=createOpenSpades
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=134217728 -sSTACK_SIZE=1048576
  -sENVIRONMENT=web,node -sASSERTIONS=1 -sFILESYSTEM=0
  "-sEXPORTED_FUNCTIONS=['_malloc','_free']"
  "-sEXPORTED_RUNTIME_METHODS=['HEAPF32','HEAPU32','HEAPU8','HEAP8','UTF8ToString','stringToNewUTF8']")
set_target_properties(openspades PROPERTIES SUFFIX ".js" RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_SOURCE_DIR}/dist/engine")
