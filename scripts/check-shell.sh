#!/usr/bin/env bash
set -euo pipefail

bash -n \
  install.sh \
  scripts/run-isolated-amneziawg2-client.sh \
  scripts/vpn-router-command.sh \
  scripts/vpn-router-data-update.sh \
  scripts/vpn-router-service.sh \
  scripts/vpn-router-watchdog.sh \
  scripts/vpn-router-source-lifecycle.sh \
  scripts/vpn-router-lifecycle.sh \
  lab/linux-interface/verify.sh

sh -n \
  scripts/preflight-amneziawg2.sh \
  scripts/prepare-amneziawg2-artifacts.sh \
  lab/install/verify.sh \
  lab/verify.sh \
  lab/redirect/verify.sh

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck \
    install.sh \
    scripts/run-isolated-amneziawg2-client.sh \
    scripts/vpn-router-command.sh \
    scripts/vpn-router-data-update.sh \
    scripts/vpn-router-service.sh \
    scripts/vpn-router-watchdog.sh \
    scripts/vpn-router-source-lifecycle.sh \
    scripts/vpn-router-lifecycle.sh \
    lab/linux-interface/verify.sh \
    scripts/preflight-amneziawg2.sh \
    scripts/prepare-amneziawg2-artifacts.sh \
    lab/install/verify.sh \
    lab/verify.sh \
    lab/redirect/verify.sh
fi

echo 'shell_check=PASS'
