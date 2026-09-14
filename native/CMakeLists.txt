cmake_minimum_required(VERSION 3.16)
project(boid_brush VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# --- Dependencies -----------------------------------------------------------

find_package(Vulkan REQUIRED)
find_package(SDL2   REQUIRED)

# SDL2's CMake support varies across distros; handle both conventions.
if(TARGET SDL2::SDL2)
    set(SDL2_LIBS SDL2::SDL2)
else()
    set(SDL2_LIBS ${SDL2_LIBRARIES})
    include_directories(${SDL2_INCLUDE_DIRS})
endif()

# --- Executable -------------------------------------------------------------

add_executable(boid_brush
    src/main.cpp
    src/canvas.cpp
    src/vk_renderer.cpp
)

target_include_directories(boid_brush PRIVATE src)
target_link_libraries(boid_brush PRIVATE Vulkan::Vulkan ${SDL2_LIBS})

# --- Compile shaders --------------------------------------------------------

find_program(GLSLC glslc HINTS
    "$ENV{VULKAN_SDK}/bin"
    "$ENV{VULKAN_SDK}/Bin"
)
if(NOT GLSLC)
    message(FATAL_ERROR
        "glslc not found. Install the Vulkan SDK or add glslc to your PATH.")
endif()

set(SHADER_SRC_DIR ${CMAKE_SOURCE_DIR}/shaders)
set(SHADER_BIN_DIR ${CMAKE_BINARY_DIR}/shaders)
file(MAKE_DIRECTORY ${SHADER_BIN_DIR})

set(SHADER_SOURCES
    ${SHADER_SRC_DIR}/fullscreen.vert
    ${SHADER_SRC_DIR}/fullscreen.frag
)

set(SHADER_SPIRV "")
foreach(SRC ${SHADER_SOURCES})
    get_filename_component(NAME ${SRC} NAME)
    set(SPV ${SHADER_BIN_DIR}/${NAME}.spv)
    add_custom_command(
        OUTPUT  ${SPV}
        COMMAND ${GLSLC} ${SRC} -o ${SPV}
        DEPENDS ${SRC}
        COMMENT "Compiling shader ${NAME} → SPIR-V"
    )
    list(APPEND SHADER_SPIRV ${SPV})
endforeach()

add_custom_target(shaders ALL DEPENDS ${SHADER_SPIRV})
add_dependencies(boid_brush shaders)
