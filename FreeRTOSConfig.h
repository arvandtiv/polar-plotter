#pragma once

/* FreeRTOS configuration for RP2350 (Cortex-M33) running at 150 MHz.
 * Port: FreeRTOS-Kernel/portable/ThirdParty/GCC/RP2040 (also covers RP2350
 * via pico-sdk platform abstraction).  Heap model: heap_4 (dynamic alloc). */

/* ---- Core clock & tick ---- */
#define configCPU_CLOCK_HZ                  150000000UL
#define configTICK_RATE_HZ                  1000

/* ---- Scheduler ---- */
#define configUSE_PREEMPTION                1
#define configUSE_IDLE_HOOK                 0
#define configUSE_TICK_HOOK                 0
#define configUSE_DAEMON_TASK_STARTUP_HOOK  0
#define configMAX_PRIORITIES                8
#define configMINIMAL_STACK_SIZE            256   /* words */
#define configTOTAL_HEAP_SIZE               (256 * 1024)

/* ---- Features ---- */
#define configUSE_MUTEXES                   1
#define configUSE_RECURSIVE_MUTEXES         1
#define configUSE_COUNTING_SEMAPHORES       1
#define configUSE_QUEUE_SETS                0
#define configQUEUE_REGISTRY_SIZE           8
#define configUSE_TIMERS                    1
#define configTIMER_TASK_PRIORITY           (configMAX_PRIORITIES - 1)
#define configTIMER_QUEUE_LENGTH            10
#define configTIMER_TASK_STACK_DEPTH        (configMINIMAL_STACK_SIZE * 2)
#define configUSE_STREAM_BUFFERS            1   /* for SSE log stream */
#define configSUPPORT_DYNAMIC_ALLOCATION    1
#define configSUPPORT_STATIC_ALLOCATION     0

/* ---- Runtime stats / trace ---- */
#define configGENERATE_RUN_TIME_STATS       0
#define configUSE_TRACE_FACILITY            0
#define configUSE_STATS_FORMATTING_FUNCTIONS 0

/* ---- RP2350 / Cortex-M33 hardware feature flags (required by Community port) ---- */
#define configTICK_TYPE_WIDTH_IN_BITS       TICK_TYPE_WIDTH_32_BITS
#define configENABLE_FPU                    1   /* M33 has FPU */
#define configENABLE_MPU                    0   /* MPU not used */
#define configENABLE_TRUSTZONE              0   /* TrustZone not used */

/* ---- ARM Cortex-M33 interrupt priority ---- */
#define configPRIO_BITS                     3
#define configLIBRARY_LOWEST_INTERRUPT_PRIORITY         7
#define configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY    4
#define configKERNEL_INTERRUPT_PRIORITY \
    (configLIBRARY_LOWEST_INTERRUPT_PRIORITY << (8 - configPRIO_BITS))
#define configMAX_SYSCALL_INTERRUPT_PRIORITY \
    (configLIBRARY_MAX_SYSCALL_INTERRUPT_PRIORITY << (8 - configPRIO_BITS))

/* ---- Thread-local storage (needed by lwIP) ---- */
#define configNUM_THREAD_LOCAL_STORAGE_POINTERS 5

/* ---- INCLUDE_* (optional API subset) ---- */
#define INCLUDE_vTaskDelay                  1
#define INCLUDE_vTaskDelayUntil             1
#define INCLUDE_vTaskDelete                 1
#define INCLUDE_vTaskSuspend                1
#define INCLUDE_uxTaskPriorityGet           1
#define INCLUDE_vTaskPrioritySet            1
#define INCLUDE_xSemaphoreGetMutexHolder    1
#define INCLUDE_xTaskGetCurrentTaskHandle   1
#define INCLUDE_eTaskGetState               1
#define INCLUDE_xTimerPendFunctionCall      1   /* required by xEventGroupSetBitsFromISR */

/* ---- Assertion ---- */
#define configASSERT(x) do { if (!(x)) { for (;;) {} } } while (0)
