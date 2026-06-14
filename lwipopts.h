#pragma once

/* lwIP options for Pico 2W (CYW43 / RP2350) + FreeRTOS.
 * Based on the pico-w FreeRTOS examples lwipopts.h. */

#define NO_SYS                          0   /* FreeRTOS integration */
#define SYS_LIGHTWEIGHT_PROT            1
#define LWIP_TIMEVAL_PRIVATE            0   /* pico-sdk provides struct timeval */

/* Sockets (BSD API) */
#define LWIP_SOCKET                     1
#define LWIP_NETCONN                    0
#define LWIP_COMPAT_SOCKETS             1   /* use socket() / send() / recv() directly */
#define LWIP_SOCKET_SET_ERRNO           1
#define LWIP_PROVIDE_ERRNO              1

/* Socket timeouts (needed for SO_RCVTIMEO / SO_SNDTIMEO) */
#define LWIP_SO_RCVTIMEO                1
#define LWIP_SO_SNDTIMEO                1
#define LWIP_SO_RCVBUF                  1

/* Memory */
#define MEM_LIBC_MALLOC                 0
#define MEM_ALIGNMENT                   4
#define MEM_SIZE                        (20 * 1024)
#define MEMP_NUM_TCP_SEG               32
#define MEMP_NUM_ARP_QUEUE             10
#define PBUF_POOL_SIZE                  24

/* FreeRTOS thread/mailbox sizes — all default to 0 in lwIP opt.h which triggers
 * LWIP_ASSERT panics in sys_mbox_new ("size > 0") and sys_thread_new
 * ("invalid stacksize"). Stack sizes are in bytes (LWIP_FREERTOS_THREAD_STACKSIZE_IS_STACKWORDS=0). */
#define TCPIP_THREAD_STACKSIZE          4096   /* bytes → 1024 words */
#define TCPIP_THREAD_PRIO               4
#define TCPIP_MBOX_SIZE                 8
#define DEFAULT_TCP_RECVMBOX_SIZE       8
#define DEFAULT_UDP_RECVMBOX_SIZE       6
#define DEFAULT_RAW_RECVMBOX_SIZE       6
#define DEFAULT_ACCEPTMBOX_SIZE         8

/* TCP */
#define LWIP_TCP                        1
#define TCP_MSS                         1460
#define TCP_WND                         (8 * TCP_MSS)
#define TCP_SND_BUF                     (8 * TCP_MSS)
#define TCP_SND_QUEUELEN               ((4 * (TCP_SND_BUF) + (TCP_MSS - 1)) / (TCP_MSS))
#define LWIP_TCP_KEEPALIVE              1
/* Short TIME_WAIT so status-poll connections don't exhaust the PCB pool.
 * Default MSL=60 s → TIME_WAIT=120 s is far too long for a LAN server with 5 PCBs.
 * Headroom sizing: the MCP polls /api/status every 150 ms while a job runs, so up
 * to ~7 closed sockets sit in the 1 s TIME_WAIT window at once; 16 PCBs leaves
 * room for that plus the listen socket, the SSE stream, and the active request.
 * Each tcp_pcb is ~200 B of static BSS — trivial against the RP2350's 520 KB. */
#define TCP_MSL                         500    /* ms; TIME_WAIT = 2×MSL = 1 s */
#define MEMP_NUM_TCP_PCB                16

/* UDP */
#define LWIP_UDP                        1

/* ICMP */
#define LWIP_ICMP                       1

/* ARP / Ethernet */
#define LWIP_ARP                        1
#define LWIP_ETHERNET                   1

/* DHCP */
#define LWIP_DHCP                       1
#define DHCP_DOES_ARP_CHECK             0
#define LWIP_DHCP_DOES_ACD_CHECK        0

/* DNS */
#define LWIP_DNS                        1

/* Netif callbacks */
#define LWIP_NETIF_STATUS_CALLBACK      1
#define LWIP_NETIF_LINK_CALLBACK        1
#define LWIP_NETIF_HOSTNAME             1

/* Misc */
#define LWIP_IPV4                       1
#define LWIP_IPV6                       0
#define LWIP_RAW                        1
#define LWIP_NETIF_TX_SINGLE_PBUF       1
#define LWIP_CHKSUM_ALGORITHM           3

/* Stats (disable in production to save memory) */
#define LWIP_STATS                      0
#define MEM_STATS                       0
#define SYS_STATS                       0
#define MEMP_STATS                      0
#define LINK_STATS                      0

/* Debug (all off for production) */
#define LWIP_DEBUG                      0
