"""Explicit Python MODEL, not GenVM. Executes the verified deployment source.
Models atomic writes and invokes both consensus callbacks with separate answers.
SDK storage/serialization coverage lives in tests/direct, never claimed here.
"""
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path
from types import ModuleType, SimpleNamespace
import importlib.util
import sys


class UserError(Exception): pass
class Disagreement(Exception): pass
class Address(str): pass
class TreeMap(dict): pass
class Return:
    def __init__(self, value): self.calldata = value


class Contract:
    def __new__(cls, *args):
        value = super().__new__(cls)
        for key in ('workflows', 'cases', 'reputation'): setattr(value, key, TreeMap())
        return value


class Runtime:
    def __init__(self):
        self.answers, self.prompts, self.responses = [], [], {}
        self.validator_calls = 0
        self.gl = SimpleNamespace(Contract=Contract, vm=SimpleNamespace(UserError=UserError, Return=Return, run_nondet_unsafe=self.consensus),
            public=SimpleNamespace(write=lambda f: f, view=lambda f: f),
            message=SimpleNamespace(sender_address=Address('0x'+'1'*40), origin_address=Address('0x'+'1'*40), contract_address=Address('0x'+'6'*40), chain_id=4221),
            message_raw={}, nondet=SimpleNamespace(exec_prompt=self.prompt, web=SimpleNamespace(get=self.get)),
            eq_principle=SimpleNamespace(strict_eq=lambda f: f()))
        stub = ModuleType('genlayer')
        stub.gl, stub.Address, stub.TreeMap, stub.u256, stub.allow_storage = self.gl, Address, TreeMap, int, lambda c: c
        stub.__all__ = ['gl', 'Address', 'TreeMap', 'u256', 'allow_storage']
        sys.modules['genlayer'] = stub
        spec = importlib.util.spec_from_file_location('faultline_under_test', Path(__file__).parents[2] / 'faultline.bundle.py')
        module = importlib.util.module_from_spec(spec); sys.modules[spec.name] = module
        spec.loader.exec_module(module); self.module = module
        self.time(1792022400)

    def time(self, value):
        self.gl.message_raw['datetime'] = datetime.fromtimestamp(value, timezone.utc).isoformat()

    def sender(self, address, origin=None):
        self.gl.message.sender_address = Address(address)
        self.gl.message.origin_address = Address(origin or address)

    def deploy(self, origin, attestor):
        self.contract = self.module.Faultline(origin, attestor)
        return self.contract

    def call(self, method, *args):
        old = deepcopy(vars(self.contract))
        try: return getattr(self.contract, method)(*args)
        except Exception:
            self.contract.__dict__.clear(); self.contract.__dict__.update(old)
            raise

    def prompt(self, prompt, response_format):
        self.prompts.append(prompt)
        if not self.answers: raise AssertionError('No independent mock answer supplied')
        answer = self.answers.pop(0)
        if isinstance(answer, Exception): raise answer
        return deepcopy(answer)

    def get(self, url):
        if url not in self.responses: raise UserError('missing offline response')
        return SimpleNamespace(status=200, body=self.responses[url])

    def consensus(self, leader, validator):
        answer = leader(); self.validator_calls += 1
        if not validator(Return(deepcopy(answer))): raise Disagreement('independent substantive mismatch')
        return answer
