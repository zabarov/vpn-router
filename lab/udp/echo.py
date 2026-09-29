import socket
import sys

label, address, port = sys.argv[1], sys.argv[2], int(sys.argv[3])
server = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
server.bind((address, port))
while True:
    payload, peer = server.recvfrom(2048)
    server.sendto((label + ':' + payload.decode('ascii')).encode('ascii'), peer)
