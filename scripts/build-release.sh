#!/usr/bin/env bash
set -euo pipefail

repo_dir=$(cd -- "$(dirname -- "$0")/.." && pwd)
output_dir=${1:-$repo_dir/output}

[[ $# -le 1 ]] || { echo 'Usage: scripts/build-release.sh [output-directory]' >&2; exit 2; }
cd -- "$repo_dir"
git diff --quiet --no-ext-diff
git diff --cached --quiet --no-ext-diff
[[ -z $(git ls-files --others --exclude-standard) ]] || {
  echo 'release=FAIL: untracked public files exist; commit or remove them before packaging' >&2
  exit 1
}

version=$(tr -d '\r\n' <VERSION)
[[ "$version" =~ ^[0-9]+[.][0-9]+[.][0-9]+[-.A-Za-z0-9]*$ ]] || { echo 'release=FAIL: invalid VERSION' >&2; exit 1; }
name="vpn-router-$version"
mkdir -p -- "$output_dir"
output_dir=$(cd -- "$output_dir" && pwd)
archive="$output_dir/$name.tar.gz"
checksum="$archive.sha256"
[[ ! -e "$archive" && ! -e "$checksum" ]] || { echo 'release=FAIL: output already exists' >&2; exit 1; }

temporary_tar=$(mktemp /tmp/vpn-router-release.XXXXXX)
temporary_archive="$archive.new"
cleanup() {
  [[ ! -e "$temporary_tar" ]] || /bin/rm -- "$temporary_tar"
  [[ ! -e "$temporary_archive" ]] || /bin/rm -- "$temporary_archive"
}
trap cleanup EXIT

git archive --format=tar --prefix="$name/" HEAD >"$temporary_tar"
gzip -n -c "$temporary_tar" >"$temporary_archive"

while IFS= read -r entry; do
  relative=${entry#*/}
  case "$relative" in
    source/*|.env|.env.*)
      [[ "$relative" == .env.example ]] || { echo "release=FAIL: forbidden path in archive: $relative" >&2; exit 1; }
      ;;
  esac
done < <(tar -tzf "$temporary_archive")

mv -- "$temporary_archive" "$archive"
sha256sum "$archive" >"$checksum"
chmod 644 "$archive" "$checksum"
echo 'release=PASS'
echo "archive=$archive"
echo "checksum=$checksum"
