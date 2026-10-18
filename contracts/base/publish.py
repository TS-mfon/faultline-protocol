#!/usr/bin/env python3
"""Publish exact compiler ABI and EIP-712 fields; --check detects stale publications."""
import json
import pathlib
import sys

base = pathlib.Path(__file__).resolve().parent
artifact = json.loads((base / 'out/FaultlineBondEscrow.sol/FaultlineBondEscrow.json').read_text())
abi = artifact['abi']
types = {}
for function in ('activateWorkflow', 'reserveAward', 'releaseRepair'):
    arg = next(item for item in abi if item.get('name') == function)['inputs'][0]
    name = arg['internalType'].split('.')[-1]
    types[name] = [{"name": item['name'], "type": item['type']} for item in arg['components']]
schema = {
    'domain': {'name': 'FaultlineBondEscrow', 'version': '1', 'chainId': '84532', 'verifyingContract': '<deployed escrow address>'},
    'types': types,
    'phases': {'ActivationAuthorization': 1, 'ReservationAuthorization': 2, 'ReleaseAuthorization': 3},
    'stateCodes': {'Missing': 0, 'Funding': 1, 'Active': 2, 'CaseOpen': 3, 'Reserved': 4, 'Released': 5, 'Expired': 6},
    'classes': {'absent': 0, 'primary': 1, 'contributory': 2, 'downstream_consequence': 3, 'excused': 4, 'unresolved': 5},
    'classesHash': 'keccak256(abi.encode(uint8[] classes)); NOT packed, NOT EIP-712 array hashing',
    'termsHash': 'keccak256(abi.encode(all createWorkflow arguments in ABI order))',
    'idEncoding': 'workflow/case/snapshot/decision IDs: protocol bytes32; node and remedy slugs: sha256(UTF8(id))',
    'deadlines': 'Exclusive: require now < expiry AND now < hardDeadline; release also now < repairDeadline. expiry <= hardDeadline.',
}
for path, value in ((base / 'abi/FaultlineBondEscrow.json', abi), (base / 'abi/authorization-schema.json', schema)):
    content = json.dumps(value, indent=2) + '\n'
    if '--check' in sys.argv:
        if not path.exists() or path.read_text() != content:
            raise SystemExit(f'Stale publication: {path}')
    else:
        path.write_text(content)
print('ABI and authorization schema match compiler output')
