# Reads FREERTOS_KERNEL_PATH from the environment and delegates to the
# FreeRTOS-Kernel RP2040 port cmake helper.
cmake_minimum_required(VERSION 3.13)

if (DEFINED ENV{FREERTOS_KERNEL_PATH} AND (NOT FREERTOS_KERNEL_PATH))
    set(FREERTOS_KERNEL_PATH $ENV{FREERTOS_KERNEL_PATH})
    message("Using FREERTOS_KERNEL_PATH from environment ('${FREERTOS_KERNEL_PATH}')")
endif ()

if (NOT FREERTOS_KERNEL_PATH)
    message(FATAL_ERROR "FREERTOS_KERNEL_PATH is not set. "
            "Export it: export FREERTOS_KERNEL_PATH=~/pico/FreeRTOS-Kernel")
endif ()

get_filename_component(FREERTOS_KERNEL_PATH "${FREERTOS_KERNEL_PATH}" REALPATH
                       BASE_DIR "${CMAKE_BINARY_DIR}")

if (NOT EXISTS ${FREERTOS_KERNEL_PATH})
    message(FATAL_ERROR "Directory '${FREERTOS_KERNEL_PATH}' not found")
endif ()

set(_IMPORT ${FREERTOS_KERNEL_PATH}/portable/ThirdParty/Community-Supported-Ports/GCC/RP2350_ARM_NTZ/FreeRTOS_Kernel_import.cmake)
if (NOT EXISTS ${_IMPORT})
    message(FATAL_ERROR
        "FreeRTOS RP2350 port cmake helper not found at:\n  ${_IMPORT}\n"
        "Make sure FREERTOS_KERNEL_PATH points to the FreeRTOS-Kernel repo root.")
endif ()

include(${_IMPORT})
