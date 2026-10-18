"""Synthetic offline evidence only. Never a chain receipt or a live judgment."""
import hashlib
import json

A, B, C, R, T, CONTRACT, ESCROW = ['0x' + c * 40 for c in '1234567']
NOW = 1792022400
ORIGIN = 'https://evidence.example/immutable'
WID = '0x' + 'a' * 64


def canonical(v):
    return json.dumps(v, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def raw_hash(v):
    return '0x' + hashlib.sha256(v).hexdigest()


def hash_text(v):
    return raw_hash(v.encode())


def hashed(v):
    return hash_text(canonical(v))


def manifest():
    return {'schemaVersion': 1, 'id': WID, 'title': 'Synthetic research workflow', 'domain': 'research',
            'creator': A, 'nodes': [
                {'id': n, 'version': 1, 'agent': agent, 'title': n,
                 'specification': spec, 'dependencies': deps,
                 'duties': [{'id': 'check', 'description': 'Verify source statements against the full source.'}],
                 'exceptions': ['Source unavailable despite documented retries.'], 'deadlineSeconds': 172800}
                for n, agent, spec, deps in [
                    ('source', A, 'Supply an accurate source about annual revenue.', []),
                    ('check', B, 'Check the source before passing it on.', ['source']),
                    ('publish', C, 'Publish the checked report.', ['check'])]],
            'bonds': {A: '1000', B: '1000', C: '1000'}, 'repairCap': '1000',
            'repairs': [{'id': 'correct', 'recipient': R, 'price': '101',
                         'scope': 'Correct the annual revenue throughout the report.', 'nodeIds': ['source', 'check', 'publish']}],
            'referenceHashes': [], 'policy': {'version': 1, 'responseWindowSeconds': 86400,
                'cureWindowSeconds': 86400, 'repairWindowSeconds': 172800,
                'lockDurationSeconds': 604800, 'reportWindowSeconds': 86400,
                'classWeights': {'primary': 3, 'contributory': 1}}}


def receipt(m, contract=CONTRACT):
    return {'schemaVersion': 1, 'workflowId': m['id'], 'workflowHash': hashed(m),
            'baseChainId': 84532, 'escrowAddress': ESCROW, 'tokenAddress': '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
            'genlayerChainId': 4221, 'genlayerContract': contract, 'bonds': m['bonds'].copy(),
            'lockedAt': NOW, 'expiresAt': NOW + 604800, 'txHash': hash_text('fixture funding tx'),
            'blockHash': hash_text('fixture block'), 'finalized': True, 'success': True}


def evidence(text='The revenue is 42 units; the report incorrectly says 420.', actor=A, eid='source-text'):
    return {'id': eid, 'hash': hash_text(text), 'text': text, 'submittedBy': actor}


def artifact(text):
    return {'hash': hash_text(text), 'uri': ORIGIN + '/' + hash_text(text),
            'mediaType': 'text/plain', 'size': len(text.encode())}


def handoff(m, node, text, version=1, inputs=None):
    n = next(n for n in m['nodes'] if n['id'] == node)
    return {'schemaVersion': 1, 'id': hash_text(node + str(version) + text), 'workflowId': m['id'],
            'nodeId': node, 'mandateVersion': 1, 'artifactVersion': version,
            'producer': n['agent'], 'artifact': artifact(text), 'inputs': inputs or []}


def input_of(h):
    return {'nodeId': h['nodeId'], 'handoffId': h['id'], 'artifactHash': h['artifact']['hash']}


def snapshot(w, c):
    return {'schemaVersion': 1, 'workflowId': w['manifest']['id'], 'workflowHash': w['hash'],
            'caseId': c['caseId'], 'round': c['evidenceRound'], 'evidence': c['evidence'],
            'report': c['report'], 'handoffs': w['handoffs'],
            'acknowledgments': [{**a, 'txHash': hashed(a)} for a in w['acknowledgments']]}


def decision(s, outcome='DECIDED'):
    return {'schemaVersion': 1, 'workflowId': s['workflowId'], 'caseId': s['caseId'], 'snapshotHash': hashed(s),
            'outcome': outcome, 'findings': [
                {'nodeId': node, 'class': cls, 'dutyIds': ['check'] if cls != 'downstream_consequence' else [],
                 'evidenceRefs': [s['evidence'][0]['id']], 'reason': 'Synthetic cited passage supports this finding.'}
                for node, cls in [('source', 'primary'), ('check', 'contributory'), ('publish', 'downstream_consequence')]],
            'edges': [{'from': x, 'to': y, 'evidenceRefs': [s['evidence'][0]['id']]}
                      for x, y in [('source', 'check'), ('check', 'publish')]],
            'remedyId': 'correct' if outcome == 'DECIDED' else None,
            'requestedEvidence': ['Supply the original source.'] if outcome == 'NEEDS_EVIDENCE' else [],
            'rationale': 'Synthetic judgment for lifecycle tests only.'}


def repair(w, c):
    txt = 'The corrected annual revenue is 42 units throughout the report.'
    latest = {h['nodeId']: h for h in c['snapshot']['handoffs']}
    return {'schemaVersion': 1, 'workflowId': w['workflowId'], 'caseId': c['caseId'], 'remedyId': 'correct',
            'recipient': R, 'artifacts': [artifact(txt)], 'evidence': [evidence(txt, R, 'repair-text')],
            'previousHashes': sorted(set(h['artifact']['hash'] for h in latest.values())) or [w['hash']]}


def verdict(w, c, accepted=True):
    return {'schemaVersion': 1, 'workflowId': w['workflowId'], 'caseId': c['caseId'],
            'decisionId': c['decisionId'], 'repairHash': c['repairHash'], 'remedyId': 'correct',
            'accepted': accepted, 'checks': [{'nodeId': n, 'satisfied': accepted} for n in ['source', 'check', 'publish']],
            'evidenceRefs': ['repair-text'], 'rationale': 'Synthetic repair verification only.'}
