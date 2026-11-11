#!/usr/bin/env bash
set -euo pipefail

readonly apt_sources_file=/etc/apt/sources.list.d/ubuntu.sources
readonly apt_mirrors_file=/etc/apt/apt-mirrors.txt
readonly apt_config_file=/etc/apt/apt.conf.d/zzzzzz-ci-apt-network-bounds
readonly fallback_mirror='https://mirrors.edge.kernel.org/ubuntu/'

if [[ $# -eq 0 ]]; then
  echo "Usage: $0 <command> [args...]" >&2
  exit 2
fi

if [[ ! -f "$apt_sources_file" || ! -f "$apt_mirrors_file" ]]; then
  echo "Expected the Ubuntu 24.04 mirror+file configuration at $apt_sources_file and $apt_mirrors_file" >&2
  exit 2
fi

if ! grep -Eq '^URIs:[[:space:]]*mirror\+file:/etc/apt/apt-mirrors\.txt([[:space:]]|$)' "$apt_sources_file"; then
  echo "Ubuntu sources do not use the expected mirror+file configuration; refusing to rewrite APT sources" >&2
  exit 2
fi
if ! grep -Eq '^Suites:.*\bnoble-updates\b' "$apt_sources_file" || \
  ! grep -Eq '^Suites:.*\bnoble-security\b' "$apt_sources_file"; then
  echo "Ubuntu sources are missing noble-updates or noble-security; refusing to continue" >&2
  exit 2
fi

mode=${APT_MIRROR_TEST_MODE:-normal}
if [[ "$mode" != normal && "$mode" != force-fallback && "$mode" != fail-all ]]; then
  echo "APT_MIRROR_TEST_MODE must be normal, force-fallback, or fail-all" >&2
  exit 2
fi

echo "APT mirror mode: $mode"
echo "Ubuntu source configuration:"
cat "$apt_sources_file"

for required_mirror in \
  'azure.archive.ubuntu.com/ubuntu/' \
  'archive.ubuntu.com/ubuntu/' \
  'security.ubuntu.com/ubuntu/'; do
  if ! grep -Fq "$required_mirror" "$apt_mirrors_file"; then
    echo "APT mirror list is missing $required_mirror; refusing to continue" >&2
    exit 2
  fi
done

if ! grep -Fq "$fallback_mirror" "$apt_mirrors_file"; then
  printf '%s\tpriority:4\n' "$fallback_mirror" | sudo tee -a "$apt_mirrors_file" >/dev/null
fi

if [[ "$mode" == force-fallback ]]; then
  awk -v fallback="$fallback_mirror" '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { print; next }
    {
      sub(/[[:space:]]*priority:[0-9]+$/, "")
      if (index($0, fallback)) print $0 "\tpriority:1"
      else {
        sub(/^https?:\/\/[^[:space:]]+/, "https://apt-primary-disabled.invalid/ubuntu/")
        print $0 "\tpriority:99"
      }
    }
  ' "$apt_mirrors_file" | sudo tee "$apt_mirrors_file.tmp" >/dev/null
  sudo mv "$apt_mirrors_file.tmp" "$apt_mirrors_file"
elif [[ "$mode" == fail-all ]]; then
  awk '
    /^[[:space:]]*#/ || /^[[:space:]]*$/ { print; next }
    {
      sub(/^https?:\/\/[^[:space:]]+/, "https://apt-mirror-outage.invalid/ubuntu/")
      print
    }
  ' "$apt_mirrors_file" | sudo tee "$apt_mirrors_file.tmp" >/dev/null
  sudo mv "$apt_mirrors_file.tmp" "$apt_mirrors_file"
fi

# Ubuntu 24.04 GitHub runners currently use these bounds too. Put our file last so
# an image default cannot silently restore apt's much longer retry/timeout values.
sudo tee "$apt_config_file" >/dev/null <<'APT_CONF'
Acquire::Retries "1";
Acquire::http::Timeout "15";
Acquire::https::Timeout "15";
APT_CONF

echo "APT mirrors available to mirror+file:"
cat "$apt_mirrors_file"
echo "Effective APT network bounds:"
apt-config dump Acquire::Retries Acquire::http::Timeout Acquire::https::Timeout

# Check every configured Ubuntu suite, including noble-security, without making
# unrelated third-party APT sources a prerequisite for this browser install.
set +e
timeout --signal=TERM --kill-after=10s 90s sudo apt-get \
  -o APT::Update::Error-Mode=any \
  -o "Dir::Etc::sourcelist=$apt_sources_file" \
  -o Dir::Etc::sourceparts=- \
  update
preflight_status=$?
set -e
if [[ "$preflight_status" -ne 0 ]]; then
  echo "Ubuntu repository index preflight failed" >&2
  exit "$preflight_status"
fi

# Playwright performs apt update and installs the complete Chromium system
# dependency set. Keep that command's exit code; tests and install errors fail CI.
set +e
timeout --signal=TERM --kill-after=10s 300s "$@"
command_status=$?
set -e
if [[ "$command_status" -eq 124 ]]; then
  echo "Playwright Chromium installation exceeded the 5-minute CI limit" >&2
fi
exit "$command_status"
