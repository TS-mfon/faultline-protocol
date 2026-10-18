#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.."
# Share the one durable deployment journal with the direct TypeScript entry point.
bash contracts/genlayer/verify.sh
node --import tsx scripts/deploy-contract.ts genlayer
