# Standard pico_sdk_import.cmake — copy from pico-sdk/external/pico_sdk_import.cmake
# Reads PICO_SDK_PATH from the environment.
cmake_minimum_required(VERSION 3.13)

if (DEFINED ENV{PICO_SDK_PATH} AND (NOT PICO_SDK_PATH))
    set(PICO_SDK_PATH $ENV{PICO_SDK_PATH})
    message("Using PICO_SDK_PATH from environment ('${PICO_SDK_PATH}')")
endif ()

if (NOT PICO_SDK_PATH)
    message(FATAL_ERROR "PICO_SDK_PATH is not set. "
            "Export it: export PICO_SDK_PATH=~/pico/pico-sdk")
endif ()

get_filename_component(PICO_SDK_PATH "${PICO_SDK_PATH}" REALPATH BASE_DIR "${CMAKE_BINARY_DIR}")

if (NOT EXISTS ${PICO_SDK_PATH})
    message(FATAL_ERROR "Directory '${PICO_SDK_PATH}' not found")
endif ()

set(PICO_SDK_INIT_CMAKE_FILE ${PICO_SDK_PATH}/pico_sdk_init.cmake)
if (NOT EXISTS ${PICO_SDK_INIT_CMAKE_FILE})
    message(FATAL_ERROR "Not a Pico SDK: '${PICO_SDK_PATH}'")
endif ()

include(${PICO_SDK_INIT_CMAKE_FILE})
