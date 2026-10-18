"""Real genlayer-test direct mode, using actual pinned SDK storage and calldata.
No network, simulator, listeners, child-process pipes, or live model calls.
"""
from pathlib import Path
from datetime import datetime, timezone
import json
import os
import sys
import unittest

HERE = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(HERE / 'tests'))
from fixtures import *

try:
    from gltest.direct import VMContext, deploy_contract
    from gltest.direct import sdk_loader
except ImportError as exc:
    print('REAL_DIRECT_UNAVAILABLE: ' + str(exc), flush=True)
    raise SystemExit(3)

# Reuse installed/downloaded tool artifacts read-only; the local cache holds only
# symlinks. Do not allow the SDK loader to attempt a download in this offline suite.
SDK_VERSION = 'v0.3.0-rc7'
RUNNER = '1jb45aa8ynh2a9c9xn3b7qqh8sm5q93hwfp7jqmwsfhh8jpz09h6'
STD = '11rhn002yfajawsz7fai6mykznbxkxs6l91iskj5cm82c92qhy3v'
source = Path(os.environ.get('FAULTLINE_GENVM_CACHE', str(Path.home() / '.cache/genvm-linter')))
archive = source / f'genvm-universal-{SDK_VERSION}.tar.xz'
extracted = source / 'extracted' / (SDK_VERSION + '.tar')
if not archive.is_file() or not (extracted / 'py-genlayer' / RUNNER / 'runner.json').is_file() or not (extracted / 'py-lib-genlayer-std' / STD / 'genlayer').is_dir():
    print('REAL_DIRECT_UNAVAILABLE: cached pinned GenVM archive/SDK missing. Use genvm-lint download first.', flush=True)
    raise SystemExit(3)
sdk_loader.CACHE_DIR = HERE / '.tools/direct-sdk'
sdk_loader.CACHE_DIR.mkdir(parents=True, exist_ok=True)
archive_link = sdk_loader.CACHE_DIR / archive.name
if not archive_link.exists(): archive_link.symlink_to(archive)
for kind, identity in [('py-genlayer', RUNNER), ('py-lib-genlayer-std', STD)]:
    target = sdk_loader.CACHE_DIR / 'extracted' / SDK_VERSION / kind / identity
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.exists(): target.symlink_to(extracted / kind / identity, target_is_directory=True)


class DirectTests(unittest.TestCase):
    def setUp(self):
        self.vm = VMContext(_chain_id=4221); self.vm.sender = bytes.fromhex(A[2:])
        self.vm.warp('2026-10-15T00:00:00Z')
        self.active = self.vm.activate(); self.active.__enter__()
        self.addCleanup(self.active.__exit__, None, None, None)
        # Each test represents a fresh VM. The pinned SDK's module-global single-
        # contract registry outlives gltest 0.29.2 contexts, so reset that registry.
        registry = sys.modules.get('genlayer.gl.genvm_contracts')
        if registry is not None: registry.__known_contract__ = None
        self.c = deploy_contract(HERE / 'faultline.bundle.py', self.vm, ORIGIN, T, sdk_version=SDK_VERSION)
        from genlayer import gl
        self.gl = gl; self.contract_address = str(gl.message.contract_address).lower()
        self.m = manifest(); self.at(NOW); self.actor(A)
        self.c.register_workflow(canonical(self.m))

    def actor(self, who): self.vm.sender = bytes.fromhex(who[2:])
    def at(self, timestamp):
        iso = datetime.fromtimestamp(timestamp, timezone.utc).isoformat()
        self.vm.warp(iso)
        # genlayer-test 0.29.2 warp patches datetime.now(), but does not refresh
        # the pinned runner's raw transaction datetime used by this contract.
        self.gl.message_raw['datetime'] = iso
    def wf(self): return json.loads(self.c.get_workflow(WID))
    def case(self): return json.loads(self.c.get_case(WID))
    def call(self, method, *args):
        snap = self.vm.snapshot()
        try: return getattr(self.c, method)(*args)
        except BaseException:
            self.vm.revert(snap)  # SDK direct proxy itself does not roll back writes.
            raise
    def fail(self, code, method=None, *args):
        if method is None: return super().fail(code)
        before = self.wf()
        with self.vm.expect_revert(code): self.call(method, *args)
        self.assertEqual(before, self.wf())
    def activate(self):
        for a in (A,B,C): self.actor(a); self.c.accept_mandate(WID)
        self.actor(T); self.c.activate_workflow(WID, canonical(receipt(self.m, self.contract_address)))
    def open(self):
        self.activate(); self.actor(A)
        self.c.open_case(WID,canonical({'nodeId':'source','impact':'Wrong revenue','reporter':A}))
        self.c.submit_evidence(WID,canonical(evidence()))
    def freeze(self):
        for a in (A,B,C): self.actor(a); self.c.close_evidence(WID)
        return snapshot(self.wf(),self.case())
    def web(self, doc):
        h=hashed(doc); url=ORIGIN+'/'+h
        self.vm.mock_web(url, {'response':{'status':200,'headers':{},'body':canonical(doc).encode()},'method':'GET'})
        return url,h
    def judge(self, s=None, d=None):
        s=s or self.freeze();d=d or decision(s)
        self.vm.clear_mocks();url,h=self.web(s)
        self.vm.mock_llm('FAULTLINE_RESPONSIBILITY_V1',canonical(d));self.actor(T)
        self.c.adjudicate(WID,url,h)
        return d
    def submit(self):
        self.at(self.case()['cureDeadline']);self.actor(R);r=repair(self.wf(),self.case())
        self.vm.clear_mocks();url,h=self.web(r);self.c.submit_repair(WID,url,h)
        return r

    def test_configuration_exposes_immutable_bridge_identity(self):
        self.assertEqual(json.loads(self.c.get_configuration()), {"schemaVersion": 1, "evidenceOrigin": ORIGIN, "fundingAttestor": T})

    def test_native_storage_acceptance_and_funding_auth(self):
        self.assertEqual(self.wf()['workflowHash'],hashed(self.m))
        self.actor(R);self.fail('PARTICIPANT_REQUIRED','accept_mandate',WID)
        self.actor(A);self.c.accept_mandate(WID);self.c.accept_mandate(WID)
        self.assertEqual(self.wf()['accepted'],[A])
        self.fail('ATTESTOR_REQUIRED','activate_workflow',WID,canonical(receipt(self.m,self.contract_address)))
        self.activate();self.assertEqual(self.wf()['bonded'],self.m['bonds'])

    def test_real_storage_handoff_ack_and_stale_input(self):
        self.activate();self.actor(A);h=handoff(self.m,'source','source one')
        self.c.record_handoff(canonical(h));self.actor(B);b=handoff(self.m,'check','checked',inputs=[input_of(h)])
        self.fail('INPUT_NOT_ACKNOWLEDGED','record_handoff',canonical(b))
        self.c.acknowledge_handoff(WID,h['id']);self.c.record_handoff(canonical(b))
        self.actor(A);h2=handoff(self.m,'source','source two',2);self.c.record_handoff(canonical(h2))
        self.actor(B);b2=handoff(self.m,'check','checked two',2,[input_of(h)])
        self.fail('STALE_INPUT','record_handoff',canonical(b2))
        self.assertEqual(self.wf()['handoffs'][1],b)

    def test_real_mocked_judgment_repair_and_reputation(self):
        self.open();self.judge();self.assertEqual(self.wf()['status'],'decided')
        self.assertTrue(self.vm.run_validator(), 'independent responsibility callback')
        self.assertEqual(self.case()['allocations'][0]['amount'],'76')
        self.submit();self.assertIsNone(self.wf()['repairAccepted'])
        v=verdict(self.wf(),self.case());self.vm.clear_mocks();self.vm.mock_llm('FAULTLINE_REPAIR_V1',canonical(v))
        self.actor(C);self.c.verify_repair(WID)
        self.assertTrue(self.vm.run_validator(), 'independent repair callback')
        self.assertIs(self.wf()['repairAccepted'],True)
        self.assertEqual(self.c.get_reputation(A,'research')['primary'],1)
        self.assertEqual(self.c.get_reputation(R,'research')['repairsAccepted'],1)
        self.assertEqual(self.case()['decisionHash'],self.wf()['decisionHash'])

    def test_captured_validator_rejects_substantive_mismatch_bad_leader_and_errors(self):
        self.open();s=self.freeze();d=self.judge(s)
        self.vm.clear_mocks();independent=decision(s)
        independent['findings'][1]['class']='downstream_consequence';independent['findings'][1]['dutyIds']=[]
        self.vm.mock_llm('FAULTLINE_RESPONSIBILITY_V1',canonical(independent))
        self.assertFalse(self.vm.run_validator())
        self.assertFalse(self.vm.run_validator(leader_result={'outcome':'DECIDED'}))
        self.assertFalse(self.vm.run_validator(leader_error='[LLM_ERROR] broken output'))
        # Direct mode commits leader-only state by design. Callback assertions above
        # verify functions, not native validator quorum, rotation or finalization.

    def test_round_two_native_storage_and_unresolved_no_payout(self):
        self.open();s=self.freeze();self.judge(s,decision(s,'NEEDS_EVIDENCE'))
        self.assertEqual(self.case()['evidenceRound'],2)
        self.assertEqual(self.c.get_reputation(A,'research')['cases'],0)
        self.actor(B);self.c.submit_evidence(WID,canonical(evidence('The original source.',B,'original')))
        s=self.freeze();self.judge(s,decision(s,'UNRESOLVED'))
        self.assertEqual(self.wf()['status'],'unresolved');self.assertEqual(self.case()['allocations'],[])
        self.assertEqual(len(self.case()['history']),2)

    def test_deadlines_use_chain_time_and_expiry_cannot_accept_repair(self):
        self.open();self.judge();self.submit();self.at(self.case()['repairDeadline'])
        self.fail('REPAIR_DEADLINE','verify_repair',WID)
        self.c.expire_workflow(WID);self.assertEqual(self.wf()['status'],'recovery_failed')
        self.assertIsNone(self.wf()['repairAccepted'])
        self.assertEqual(self.c.get_reputation(R,'research')['repairsAccepted'],0)


if __name__ == '__main__':
    unittest.main(argv=[sys.argv[0]], verbosity=2)
