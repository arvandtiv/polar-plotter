add_library(tmc5072 tmc5072.c)
target_include_directories(tmc5072 PUBLIC include)
target_link_libraries(tmc5072
    pico_stdlib
    hardware_spi
    hardware_gpio
    FreeRTOS-Kernel
)
