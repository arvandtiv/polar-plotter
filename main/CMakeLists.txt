add_executable(polar_plotter
    main.c
    web_server.c
)

target_include_directories(polar_plotter PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}
    ${CMAKE_SOURCE_DIR}
)

target_link_libraries(polar_plotter
    pico_stdlib
    pico_float
    pico_cyw43_arch_lwip_sys_freertos
    FreeRTOS-Kernel-Heap4
    hardware_spi
    hardware_pwm
    hardware_gpio
    tmc5072
    servo
)

pico_enable_stdio_usb(polar_plotter 1)
pico_enable_stdio_uart(polar_plotter 0)
pico_add_extra_outputs(polar_plotter)
