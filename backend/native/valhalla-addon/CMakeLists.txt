cmake_minimum_required(VERSION 3.25)

find_package(cmake-bare REQUIRED PATHS node_modules/cmake-bare)
find_package(PkgConfig QUIET)

project(valhalla_native C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

find_package(Boost REQUIRED)

option(VALHALLA_USE_PKG_CONFIG "Use pkg-config to resolve Valhalla deps" ON)
set(VALHALLA_ROOT "" CACHE PATH "Prefix where Valhalla headers/libs are installed")
set(VALHALLA_LIBRARY "" CACHE FILEPATH "Absolute path to libvalhalla")

add_bare_module(valhalla_native)

target_sources(
  ${valhalla_native}
  PRIVATE
    binding.cc
)

target_include_directories(
  ${valhalla_native}
  PRIVATE
    ${Boost_INCLUDE_DIRS}
)

if(VALHALLA_ROOT)
  target_include_directories(
    ${valhalla_native}
    PRIVATE
      "${VALHALLA_ROOT}/include"
  )
  target_link_directories(
    ${valhalla_native}
    PRIVATE
      "${VALHALLA_ROOT}/lib"
  )
endif()

if(VALHALLA_USE_PKG_CONFIG AND PkgConfig_FOUND)
  pkg_check_modules(VALHALLA QUIET IMPORTED_TARGET libvalhalla)
  if(NOT VALHALLA_FOUND)
    pkg_check_modules(VALHALLA QUIET IMPORTED_TARGET valhalla)
  endif()
  if(VALHALLA_FOUND)
    target_link_libraries(${valhalla_native} PRIVATE PkgConfig::VALHALLA)
  endif()

  pkg_check_modules(PROTOBUF_LITE QUIET IMPORTED_TARGET protobuf-lite)
  if(PROTOBUF_LITE_FOUND)
    target_link_libraries(${valhalla_native} PRIVATE PkgConfig::PROTOBUF_LITE)
  endif()
endif()

if(VALHALLA_LIBRARY)
  target_link_libraries(${valhalla_native} PRIVATE "${VALHALLA_LIBRARY}")
elseif(NOT VALHALLA_FOUND)
  target_link_libraries(${valhalla_native} PRIVATE valhalla)
endif()
