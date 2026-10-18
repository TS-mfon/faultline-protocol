#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"
forge fmt --check
forge test --root . --offline
python3 publish.py --check
python3 - <<'PY'
import json
from pathlib import Path
artifact = json.loads(Path('out/FaultlineBondEscrow.sol/FaultlineBondEscrow.json').read_text())
size = len(bytes.fromhex(artifact['deployedBytecode']['object'].removeprefix('0x')))
assert 0 < size <= 24576, f'EIP-170 runtime size exceeded: {size}'
abi = json.loads(Path('abi/FaultlineBondEscrow.json').read_text())
functions = {a.get('name') for a in abi if a['type'] == 'function'}
assert {'createWorkflow', 'depositBond', 'activateWorkflow', 'openCase', 'reserveAward', 'releaseRepair', 'refundExpired', 'withdraw', 'withdrawFor', 'getWorkflow', 'getAccount', 'getTerms', 'pause'} <= functions
schema = json.loads(Path('abi/authorization-schema.json').read_text())
samples = json.loads(Path('examples/authorizations.json').read_text())['examples']
for name, fields in schema['types'].items():
    assert samples[name]['types'][name] == fields, f'Stale example type: {name}'
    assert set(samples[name]['message']) == {f['name'] for f in fields}, f'Missing example fields: {name}'
    assert samples[name]['message']['phase'] == schema['phases'][name]
print(f'ESCROW:PASS; runtime {size}/24576 bytes; ABI and examples verified')
PY
