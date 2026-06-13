add_executable(polar_plotter
    main.c
    web_server.c
)

target_include_directories(polar_plotter PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_SOURCE_DIR}            # picks up FreeRTOSConfig.h and lwipopts.h
)

target_link_libraries(polar_plotter
    pico_stdlib
    pico_float                     # sqrtf / cosf / sinf
    pico_cyw43_arch_lwip_freertos  # WiFi + lwIP + FreeRTOS
    FreeRTOS-Kernel-Heap4
    hardware_spi
    hardware_pwm
    hardware_gpio
    tmc5072
    servo
)

# USB CDC for the serial console (no physical UART needed)
pico_enable_stdio_usb(polar_plotter 1)
pico_enable_stdio_uart(polar_plotter 0)

# Produce .uf2 / .bin / .elf for flashing
pico_add_extra_outputs(polar_plotter)
