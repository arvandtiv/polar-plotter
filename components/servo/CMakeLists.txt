add_library(servo servo.c)
target_include_directories(servo PUBLIC include)
target_link_libraries(servo
    pico_stdlib
    hardware_pwm
    hardware_gpio
)
