import socket
import sys

source, destination, port, expected = sys.argv[1], sys.argv[2], int(sys.argv[3]), sys.argv[4]
client = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
client.settimeout(1.5)
client.bind((source, 0))
try:
    client.sendto(b'probe', (destination, port))
    response = client.recv(2048).decode('ascii')
except (OSError, UnicodeError):
    response = 'blocked'
if response != expected:
    raise SystemExit(f'FAIL: expected {expected}, received {response}')
print(f'PASS: {source} -> {destination}:{port} = {response}')
