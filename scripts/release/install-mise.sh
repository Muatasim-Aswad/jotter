#!/usr/bin/env bash
set -euo pipefail
installation="${RUNNER_TEMP:?GitHub runner temporary directory required}/jotter-mise"
mkdir -p "${installation}"
curl --fail --silent --show-error --location \
  https://github.com/jdx/mise/releases/download/v2026.10.7/mise-v2026.10.7-linux-x64.tar.gz \
  --output "${installation}/mise.tar.gz"
printf '%s  %s\n' 3d31e3a53e8041b278ca999a4772d4575583098025384126e7aa8a31e0dac11c "${installation}/mise.tar.gz" | sha256sum --check --status
tar -xzf "${installation}/mise.tar.gz" -C "${installation}" mise/bin/mise
printf '%s\n' "${installation}/mise/bin" >> "${GITHUB_PATH:?GitHub path file required}"
