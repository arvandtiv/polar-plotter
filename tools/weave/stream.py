"""UDP point streaming to the polar_plotter firmware's pattern_stream_task
(see ../../main/main.c -- listens on PATTERN_LISTEN_PORT for one drawing
point per datagram, ASCII "<m1_target> <m2_target> <pen 0|1>"). The firmware
walks points in the order received and paces itself (it doesn't ask for the
next point until the current move finishes), so this side just needs to send
them in order -- no flow control required.
"""
import socket

DEFAULT_PORT = 8889


class PatternStream:
    def __init__(self, host, port=DEFAULT_PORT):
        self._addr = (host, port)
        self._sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)

    def send_point(self, m1, m2, pen_down):
        msg = f"{m1} {m2} {1 if pen_down else 0}".encode()
        self._sock.sendto(msg, self._addr)

    def close(self):
        self._sock.close()
