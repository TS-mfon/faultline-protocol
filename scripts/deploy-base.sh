#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
# The TypeScript entry point is the single deployment signing journal.
bash contracts/base/verify.sh
node --import tsx scripts/deploy-contract.ts base
