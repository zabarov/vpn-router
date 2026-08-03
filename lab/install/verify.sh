#!/bin/sh
set -eu

repo_dir=$(cd -- "$(dirname -- "$0")/../.." && pwd)
image='ubuntu.azurecr.io/ubuntu:24.04@sha256:be20a0347f238b7d373edddc55923443b21dd9a60277bf8a93e43458cd0bf2fc'

docker run --rm \
  -v "$repo_dir:/src:ro" \
  "$image" \
  sh -ec '
    export DEBIAN_FRONTEND=noninteractive
    apt-get update >/dev/null
    apt-get install -y ca-certificates curl xz-utils >/dev/null
    /src/install.sh install --no-systemd --skip-runtime-check
    test "$(vpn-router version)" = "$(cat /src/VERSION)"
    vpn-router discover --help >/dev/null
    vpn-router configure --non-interactive --output /etc/vpn-router/router.yaml \
      --preset amnezia-tailscale \
      --source-container source-vpn --source-interface awg0 \
      --client-addresses 10.44.0.2/32 \
      --exit-node exit.example.ts.net >/dev/null
    vpn-router validate >/dev/null
    old_release=$(readlink /opt/vpn-router/current)
    mkdir -p /candidate
    cp /src/install.sh /src/VERSION /src/package.json /src/package-lock.json /src/config.example.yaml /candidate/
    cp -a /src/bin /src/src /src/scripts /src/deploy /src/schema /candidate/
    sed -i -e "\$G" /candidate/bin/vpn-router.mjs
    /candidate/install.sh upgrade --no-systemd --skip-runtime-check >/dev/null
    new_release=$(readlink /opt/vpn-router/current)
    test "$new_release" != "$old_release"
    test "$(readlink /opt/vpn-router/previous)" = "$old_release"
    /candidate/install.sh rollback-version --no-systemd --skip-runtime-check >/dev/null
    test "$(readlink /opt/vpn-router/current)" = "$old_release"
    /src/install.sh uninstall --no-systemd >/tmp/uninstall.out
    grep -Fxq uninstall=PASS /tmp/uninstall.out
    test -f /etc/vpn-router/router.yaml
    test ! -e /usr/local/sbin/vpn-router
    test ! -e /opt/vpn-router
  '

echo 'clean_host_install=PASS'
