#!/usr/bin/env bash
set -euo pipefail

bash -n \
  scripts/run-isolated-amneziawg2-client.sh \
  scripts/vpn-router-lifecycle.sh

sh -n \
  scripts/preflight-amneziawg2.sh \
  scripts/prepare-amneziawg2-artifacts.sh \
  lab/verify.sh \
  lab/redirect/verify.sh

if command -v shellcheck >/dev/null 2>&1; then
  shellcheck \
    scripts/run-isolated-amneziawg2-client.sh \
    scripts/vpn-router-lifecycle.sh \
    scripts/preflight-amneziawg2.sh \
    scripts/prepare-amneziawg2-artifacts.sh \
    lab/verify.sh \
    lab/redirect/verify.sh
fi

echo 'shell_check=PASS'
