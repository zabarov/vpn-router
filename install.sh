#!/usr/bin/env bash
set -euo pipefail

readonly NODE_VERSION='24.18.0'
readonly NODE_SHA256_X64='55aa7153f9d88f28d765fcdad5ae6945b5c0f98a36881703817e4c450fa76742'
readonly NODE_SHA256_ARM64='58c9520501f6ae2b52d5b210444e24b9d0c029a58c5011b797bc1fe7105886f6'

source_dir=$(cd -- "$(dirname -- "$0")" && pwd)
action=${1-install}
if (($# > 0)); then shift; fi

root='/'
prefix='/opt/vpn-router'
bin_dir='/usr/local/sbin'
config_dir='/etc/vpn-router'
install_dependencies=false
systemd_enabled=true
runtime_check=true
purge=false
provided_node=''

usage() {
  cat >&2 <<'EOF'
Usage:
  sudo ./install.sh install [--install-dependencies]
  sudo ./install.sh upgrade [--install-dependencies]
  sudo ./install.sh rollback-version
  sudo ./install.sh uninstall [--purge]

Options:
  --install-dependencies  Install required host packages and Docker on Debian/Ubuntu.
  --prefix <path>         Release root (default: /opt/vpn-router).
  --bin-dir <path>        Command directory (default: /usr/local/sbin).
  --config-dir <path>     Configuration directory (default: /etc/vpn-router).
  --no-systemd            Do not install the boot service.
  --purge                 With uninstall, also remove config and owned persistent state.

The following options are intended for packaging tests and image builders:
  --root <path> --skip-runtime-check --node-binary <path>
EOF
}

while (($# > 0)); do
  case "$1" in
    --install-dependencies) install_dependencies=true; shift ;;
    --no-systemd) systemd_enabled=false; shift ;;
    --skip-runtime-check) runtime_check=false; shift ;;
    --purge) purge=true; shift ;;
    --root|--prefix|--bin-dir|--config-dir|--node-binary)
      (($# >= 2)) || { usage; exit 2; }
      case "$1" in
        --root) root=$2 ;;
        --prefix) prefix=$2 ;;
        --bin-dir) bin_dir=$2 ;;
        --config-dir) config_dir=$2 ;;
        --node-binary) provided_node=$2 ;;
      esac
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) usage; exit 2 ;;
  esac
done

case "$action" in install|upgrade|rollback-version|uninstall) ;; *) usage; exit 2 ;; esac
if [[ $EUID -ne 0 ]]; then
  if [[ "${VPN_ROUTER_ALLOW_UNPRIVILEGED_TEST-}" != 1 || "$root" == / ]]; then
    echo 'install=FAIL: root privileges are required' >&2
    exit 1
  fi
fi
[[ "$root" == /* && "$prefix" == /* && "$bin_dir" == /* && "$config_dir" == /* ]] || {
  echo 'install=FAIL: all installation paths must be absolute' >&2
  exit 1
}
for path_value in "$root" "$prefix" "$bin_dir" "$config_dir"; do
  [[ "$path_value" == / || ( "$path_value" =~ ^/[A-Za-z0-9._/-]+$ && "$path_value" != *'/../'* && "$path_value" != */.. ) ]] || {
    echo "install=FAIL: unsafe installation path: $path_value" >&2
    exit 1
  }
done

physical() {
  if [[ "$root" == / ]]; then printf '%s' "$1"; else printf '%s%s' "${root%/}" "$1"; fi
}

prefix_path=$(physical "$prefix")
bin_path=$(physical "$bin_dir")
config_path=$(physical "$config_dir")
state_path=$(physical '/var/lib/vpn-router-installer')
manifest_path="$state_path/install.env"
current_link="$prefix_path/current"
previous_link="$prefix_path/previous"

install_host_dependencies() {
  [[ "$root" == / ]] || { echo 'install=FAIL: dependency installation requires --root /' >&2; return 1; }
  [[ -r /etc/os-release ]] || { echo 'install=FAIL: /etc/os-release is unavailable' >&2; return 1; }
  # shellcheck disable=SC1091
  source /etc/os-release
  [[ "${ID-}" == ubuntu || "${ID-}" == debian ]] || {
    echo 'install=FAIL: automatic dependency installation supports Debian and Ubuntu only' >&2
    return 1
  }
  apt-get update
  DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl xz-utils nftables util-linux iproute2
  if command -v docker >/dev/null 2>&1 && ! docker compose version >/dev/null 2>&1; then
    if apt-cache show docker-compose-v2 >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-v2
    elif apt-cache show docker-compose-plugin >/dev/null 2>&1; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y docker-compose-plugin
    fi
  fi
  if ! command -v docker >/dev/null 2>&1 || ! docker compose version >/dev/null 2>&1; then
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL "https://download.docker.com/linux/$ID/gpg" -o /etc/apt/keyrings/docker.asc
    chmod a+r /etc/apt/keyrings/docker.asc
    arch=$(dpkg --print-architecture)
    codename=${UBUNTU_CODENAME:-${VERSION_CODENAME:?Missing distribution codename}}
    cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/$ID
Suites: $codename
Components: stable
Architectures: $arch
Signed-By: /etc/apt/keyrings/docker.asc
EOF
    apt-get update
    if command -v docker >/dev/null 2>&1; then
      echo 'install=FAIL: the existing Docker package has no compatible Compose v2 package; install Compose for the current Docker distribution and rerun' >&2
      return 1
    fi
    DEBIAN_FRONTEND=noninteractive apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  fi
  systemctl enable --now docker.service
}

require_runtime() {
  local missing=()
  local required=(curl sha256sum tar xz)
  if [[ "$runtime_check" == true ]]; then required+=(nft nsenter ip); fi
  for name in "${required[@]}"; do
    command -v "$name" >/dev/null 2>&1 || missing+=("$name")
  done
  if ((${#missing[@]} > 0)); then
    echo "install=FAIL: missing host commands: ${missing[*]}; rerun with --install-dependencies" >&2
    return 1
  fi
  if [[ "$runtime_check" == true ]]; then
    command -v docker >/dev/null 2>&1 || { echo 'install=FAIL: Docker is missing; rerun with --install-dependencies' >&2; return 1; }
    docker info >/dev/null || { echo 'install=FAIL: Docker Engine is not running' >&2; return 1; }
    docker compose version >/dev/null || { echo 'install=FAIL: Docker Compose plugin is unavailable' >&2; return 1; }
  fi
  if [[ "$systemd_enabled" == true ]]; then
    command -v systemctl >/dev/null 2>&1 || { echo 'install=FAIL: systemd is required unless --no-systemd is used' >&2; return 1; }
    command -v systemd-run >/dev/null 2>&1 || { echo 'install=FAIL: systemd-run is required' >&2; return 1; }
  fi
}

install_node_runtime() {
  if [[ -n "$provided_node" ]]; then
    [[ -x "$provided_node" ]] || { echo 'install=FAIL: --node-binary is not executable' >&2; return 1; }
    "$provided_node" -e 'if (Number(process.versions.node.split(".")[0]) < 22) process.exit(1)' || {
      echo 'install=FAIL: --node-binary must be Node.js 22 or newer' >&2
      return 1
    }
    printf '%s' "$provided_node"
    return
  fi

  local machine node_arch expected archive runtime_dir download_dir
  machine=$(uname -m)
  case "$machine" in
    x86_64|amd64) node_arch=x64; expected=$NODE_SHA256_X64 ;;
    aarch64|arm64) node_arch=arm64; expected=$NODE_SHA256_ARM64 ;;
    *) echo "install=FAIL: unsupported architecture for bundled Node.js: $machine" >&2; return 1 ;;
  esac
  runtime_dir="$prefix_path/runtime/node-v$NODE_VERSION-linux-$node_arch"
  if [[ ! -x "$runtime_dir/bin/node" ]]; then
    mkdir -p "$prefix_path/runtime"
    download_dir=$(mktemp -d)
    trap 'rm -rf "$download_dir"' RETURN
    archive="$download_dir/node.tar.xz"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$node_arch.tar.xz" -o "$archive"
    printf '%s  %s\n' "$expected" "$archive" | sha256sum -c - >/dev/null
    tar -xJf "$archive" -C "$prefix_path/runtime"
    rm -rf "$download_dir"
    trap - RETURN
  fi
  "$runtime_dir/bin/node" --version >/dev/null
  printf '%s' "$runtime_dir/bin/node"
}

source_tree_hash() {
  (
    cd "$source_dir"
    find VERSION package.json package-lock.json bin src scripts deploy schema -type f -print0 \
      | sort -z \
      | xargs -0 sha256sum \
      | sha256sum \
      | awk '{print substr($1,1,12)}'
  )
}

write_command_wrapper() {
  local node_path=$1 temporary="$bin_path/.vpn-router.$$.tmp"
  mkdir -p "$bin_path"
  {
    printf '#!/usr/bin/env bash\n'
    printf 'export VPN_ROUTER_NODE=%q\n' "$node_path"
    printf 'export VPN_ROUTER_CONFIG=%q\n' "$config_dir/router.yaml"
    printf 'exec %q/scripts/vpn-router-command.sh "$@"\n' "$prefix/current"
  } >"$temporary"
  chmod 755 "$temporary"
  mv -f "$temporary" "$bin_path/vpn-router"
}

write_systemd_units() {
  local node_path=$1 unit_name unit_path unit_temp data_timer_active=false
  [[ "$systemd_enabled" == true ]] || return 0
  if [[ "$root" == / ]] && systemctl is-active --quiet vpn-router-data-update.timer; then data_timer_active=true; fi
  for unit_name in vpn-router.service vpn-router-watchdog.service vpn-router-watchdog.timer vpn-router-data-update.service vpn-router-data-update.timer; do
    unit_path=$(physical "/etc/systemd/system/$unit_name")
    unit_temp="$unit_path.$$.tmp"
    mkdir -p "$(dirname -- "$unit_path")"
    sed \
      -e "s|@CONFIG_PATH@|$config_dir/router.yaml|g" \
      -e "s|@ACTIVE_CONFIG_PATH@|$state_path/active-config|g" \
      -e "s|@NODE_PATH@|$node_path|g" \
      -e "s|@CURRENT_PATH@|$prefix/current|g" \
      "$source_dir/deploy/systemd/$unit_name" >"$unit_temp"
    chmod 644 "$unit_temp"
    mv -f "$unit_temp" "$unit_path"
  done
  if [[ "$root" == / ]]; then
    systemctl daemon-reload
    [[ "$data_timer_active" != true ]] || systemctl restart vpn-router-data-update.timer
  fi
}

install_release() {
  local mode=$1 version tree_hash release_id releases_dir release_dir staging node_path old_current
  [[ "$mode" == install || -f "$manifest_path" ]] || {
    echo 'upgrade=FAIL: no existing installation; run install first' >&2
    return 1
  }
  [[ "$mode" == upgrade || ! -f "$manifest_path" ]] || {
    echo 'install=FAIL: installation already exists; use upgrade' >&2
    return 1
  }
  [[ "$install_dependencies" == false ]] || install_host_dependencies
  require_runtime
  mkdir -p "$prefix_path/releases" "$state_path" "$config_path"
  chmod 700 "$state_path" "$config_path"
  node_path=$(install_node_runtime)
  version=$(tr -d '[:space:]' <"$source_dir/VERSION")
  tree_hash=$(source_tree_hash)
  release_id="$version-$tree_hash"
  releases_dir="$prefix_path/releases"
  release_dir="$releases_dir/$release_id"
  staging="$releases_dir/.staging-$release_id-$$"
  rm -rf "$staging"
  mkdir -p "$staging"
  cp -a "$source_dir/VERSION" "$source_dir/package.json" "$source_dir/package-lock.json" "$staging/"
  cp -a "$source_dir/bin" "$source_dir/src" "$source_dir/scripts" "$source_dir/deploy" "$source_dir/schema" "$staging/"
  chmod 755 "$staging/bin/"*.mjs "$staging/scripts/"*.sh
  PATH="$(dirname -- "$node_path"):$PATH" "$(dirname -- "$node_path")/npm" ci --omit=dev --ignore-scripts --prefix "$staging" >/dev/null
  VPN_ROUTER_NODE="$node_path" "$staging/scripts/vpn-router-command.sh" version >/dev/null
  if [[ -f "$config_path/router.yaml" ]]; then
    VPN_ROUTER_NODE="$node_path" VPN_ROUTER_CONFIG="$config_dir/router.yaml" \
      "$staging/scripts/vpn-router-command.sh" validate --config "$config_path/router.yaml" >/dev/null
  fi
  if [[ -d "$release_dir" ]]; then rm -rf "$staging"; else mv "$staging" "$release_dir"; fi

  old_current=''
  [[ -L "$current_link" ]] && old_current=$(readlink "$current_link")
  ln -sfn "$release_dir" "$current_link.new"
  mv -Tf "$current_link.new" "$current_link"
  if [[ -n "$old_current" && "$old_current" != "$release_dir" ]]; then ln -sfn "$old_current" "$previous_link"; fi
  write_command_wrapper "$node_path"
  write_systemd_units "$node_path"
  cp -f "$source_dir/config.example.yaml" "$config_path/router.yaml.example" 2>/dev/null || true
  chmod 600 "$config_path/router.yaml.example" 2>/dev/null || true
  umask 077
  {
    printf 'INSTALL_VERSION=%q\n' "$version"
    printf 'INSTALL_RELEASE=%q\n' "$release_dir"
    printf 'INSTALL_PREVIOUS=%q\n' "$old_current"
    printf 'INSTALL_NODE=%q\n' "$node_path"
    printf 'INSTALL_PREFIX=%q\n' "$prefix"
    printf 'INSTALL_CONFIG_DIR=%q\n' "$config_dir"
    printf 'INSTALL_UPDATED_AT=%q\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } >"$manifest_path"
  chmod 600 "$manifest_path"
  echo "$mode=PASS"
  echo "version=$version"
  echo "release=$release_id"
  if [[ ! -f "$config_path/router.yaml" ]]; then
    echo 'next=vpn-router setup (Amnezia plus Tailscale) or vpn-router configure (advanced)'
  else
    echo 'next=vpn-router preflight'
  fi
}

rollback_version() {
  [[ -f "$manifest_path" && -L "$previous_link" ]] || {
    echo 'rollback-version=FAIL: no previous installed release is available' >&2
    return 1
  }
  local current previous node_path
  # shellcheck disable=SC1090
  source "$manifest_path"
  current=$(readlink "$current_link")
  previous=$(readlink "$previous_link")
  [[ -d "$previous" ]] || { echo 'rollback-version=FAIL: previous release directory is missing' >&2; return 1; }
  node_path=$INSTALL_NODE
  if [[ -f "$config_path/router.yaml" ]]; then
    VPN_ROUTER_NODE="$node_path" "$previous/scripts/vpn-router-command.sh" validate --config "$config_path/router.yaml" >/dev/null
  fi
  ln -sfn "$previous" "$current_link.new"
  mv -Tf "$current_link.new" "$current_link"
  ln -sfn "$current" "$previous_link"
  write_command_wrapper "$node_path"
  write_systemd_units "$node_path"
  echo 'rollback-version=PASS'
  echo "release=$(basename -- "$previous")"
}

uninstall_release() {
  [[ -f "$manifest_path" ]] || { echo 'uninstall=ALREADY_ABSENT'; return 0; }
  # shellcheck disable=SC1090
  source "$manifest_path"
  local service_name=''
  if [[ -f "$config_path/router.yaml" && -x "$INSTALL_NODE" && -f "$INSTALL_RELEASE/bin/vpn-router.mjs" ]]; then
    service_name=$(VPN_ROUTER_NODE="$INSTALL_NODE" "$INSTALL_NODE" "$INSTALL_RELEASE/bin/vpn-router.mjs" render-runtime-env --config "$config_path/router.yaml" 2>/dev/null \
      | sed -n "s/^SERVICE_NAME='\([^']*\)'$/\1/p")
  fi
  local active_manifest=false
  [[ -n "$service_name" && -f "$(physical "/var/lib/$service_name/runtime/manifest.env")" ]] && active_manifest=true
  if [[ "$root" == / && "$systemd_enabled" == true ]]; then
    systemctl disable --now vpn-router-watchdog.timer >/dev/null 2>&1 || true
    systemctl disable --now vpn-router-data-update.timer >/dev/null 2>&1 || true
    systemctl stop vpn-router-data-update.service >/dev/null 2>&1 || true
    rm -f "$state_path/active-config"
  fi
  if [[ "$root" == / && "$systemd_enabled" == true && -f /etc/systemd/system/vpn-router.service ]]; then
    if systemctl is-active --quiet vpn-router.service; then
      systemctl disable --now vpn-router.service >/dev/null 2>&1 || {
        echo 'uninstall=FAIL: the systemd service could not stop safely; installation was preserved' >&2
        return 1
      }
    else
      systemctl disable vpn-router.service >/dev/null 2>&1 || true
    fi
  fi
  if [[ "$active_manifest" == true && -f "$config_path/router.yaml" && -x "$current_link/scripts/vpn-router-lifecycle.sh" ]]; then
    VPN_ROUTER_NODE="$INSTALL_NODE" "$current_link/scripts/vpn-router-lifecycle.sh" disable --config "$config_path/router.yaml" >/dev/null || {
      echo 'uninstall=FAIL: routing could not be disabled safely; installation was preserved' >&2
      return 1
    }
  fi
  rm -f "$bin_path/vpn-router" \
    "$(physical '/etc/systemd/system/vpn-router.service')" \
    "$(physical '/etc/systemd/system/vpn-router-watchdog.service')" \
    "$(physical '/etc/systemd/system/vpn-router-watchdog.timer')"
  rm -f "$(physical '/etc/systemd/system/vpn-router-data-update.service')" \
    "$(physical '/etc/systemd/system/vpn-router-data-update.timer')"
  rm -rf "$prefix_path"
  if [[ "$purge" == true ]]; then
    [[ -z "$service_name" ]] || rm -rf "$(physical "/var/lib/$service_name")"
    rm -rf "$config_path" "$state_path"
  else
    rm -f "$manifest_path"
    echo "preserved=$config_dir,/var/lib/<service_name>"
  fi
  if [[ "$root" == / && "$systemd_enabled" == true ]]; then systemctl daemon-reload; fi
  echo 'uninstall=PASS'
}

case "$action" in
  install|upgrade) install_release "$action" ;;
  rollback-version) rollback_version ;;
  uninstall) uninstall_release ;;
esac
