#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.."
python_bin="${FAULTLINE_PYTHON:-python3}"
if ! "$python_bin" -c 'import sys; assert sys.version_info[:2] == (3, 12)' >/dev/null 2>&1; then
  python_bin="$(uv python find --offline 3.12)"
fi
"$python_bin" contracts/genlayer/build.py --check
genvm-lint check contracts/genlayer/faultline.py
genvm-lint check contracts/genlayer/faultline.deploy.py
"$python_bin" -m unittest discover -s contracts/genlayer/tests/offline -p 'test_*.py' -v
if "$python_bin" -c 'import gltest.direct' >/dev/null 2>&1; then
  "$python_bin" contracts/genlayer/tests/direct/run.py
else
  "$python_bin" contracts/genlayer/tests/direct/cached_runner.py contracts/genlayer/tests/direct/run.py
fi
