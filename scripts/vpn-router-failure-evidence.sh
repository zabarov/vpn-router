#!/usr/bin/env bash

# Internal helpers shared by both lifecycle engines. Failure snapshots are
# diagnostic copies, not backups or the active runtime state.
readonly VPN_ROUTER_FAILURE_EVIDENCE_KEEP=8
readonly VPN_ROUTER_FAILURE_EVIDENCE_FILE_BYTES=32768

failure_evidence_capture() {
  local destination=$1
  shift
  "$@" 2>&1 | tail -c "$VPN_ROUTER_FAILURE_EVIDENCE_FILE_BYTES" >"$destination" || true
}

failure_evidence_prune() {
  local root=$1 path name index
  local -a snapshots=()
  [[ -d "$root" && ! -L "$root" ]] || return 1

  while IFS= read -r -d '' path; do
    name=${path##*/}
    [[ "$name" =~ ^[0-9]{8}T[0-9]{6}Z\.[[:alnum:]]{6}$ ]] || continue
    [[ -d "$path" && ! -L "$path" ]] || continue
    snapshots+=("$path")
  done < <(find "$root" -mindepth 1 -maxdepth 1 -type d -print0 | LC_ALL=C sort -z)

  for ((index = 0; index < ${#snapshots[@]} - VPN_ROUTER_FAILURE_EVIDENCE_KEEP; index++)); do
    rm -r -- "${snapshots[index]}" || return 1
  done
}
