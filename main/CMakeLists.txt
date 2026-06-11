idf_component_register(SRCS "web_server.c" "main.c"
                       INCLUDE_DIRS "."
                       REQUIRES tmc5072 servo driver console esp_driver_usb_serial_jtag
                                esp_wifi nvs_flash esp_netif lwip esp_http_server esp_timer)
