FROM ubuntu.azurecr.io/ubuntu:26.04@sha256:a5da6f6b18c3a4b8dcc73244592f7096f417d2667966d0e33460e9e308f25f67

RUN apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends dnsmasq-base iproute2 nftables \
    && rm -rf /var/lib/apt/lists/*

ENTRYPOINT ["dnsmasq", "--keep-in-foreground", "--conf-file=/etc/dnsmasq.conf"]
