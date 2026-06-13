# Polar plotter firmware — Raspberry Pi Pico 2W (RP2350) + TMC5072 + SG90
# Board: pico2_w  (set via -DPICO_BOARD=pico2_w at cmake config time)
# Requires:
#   export PICO_SDK_PATH=~/pico/pico-sdk
#   export FREERTOS_KERNEL_PATH=~/pico/FreeRTOS-Kernel
#
# Build:
#   mkdir build && cd build
#   cmake -DPICO_BOARD=pico2_w ..
#   make -j4
#   # flash with picotool or drag-drop .uf2 to the Pico's USB mass storage

cmake_minimum_required(VERSION 3.13)

include(pico_sdk_import.cmake)

# Must be set before FreeRTOS_Kernel_import so library.cmake picks it up
set(FREERTOS_CONFIG_FILE_DIRECTORY ${CMAKE_SOURCE_DIR})

include(FreeRTOS_Kernel_import.cmake)

project(polar_plotter C CXX ASM)
set(CMAKE_C_STANDARD 11)

pico_sdk_init()

add_subdirectory(components/tmc5072)
add_subdirectory(components/servo)
add_subdirectory(main)
