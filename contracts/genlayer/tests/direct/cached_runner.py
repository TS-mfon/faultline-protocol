from pathlib import Path
import sys, re, runpy
pins={'genlayer-test':'0.29.2','genlayer-py':'0.16.3','web3':'7.16.0','eth-account':'0.13.7'}
for package in (Path.home() / '.cache/uv/wheels-v6/pypi').iterdir():
    versions=[]
    for p in package.iterdir():
        if not p.is_dir(): continue
        if '-cp' in p.name and '-cp312-' not in p.name and '-abi3-' not in p.name: continue
        native=list(p.glob('*.cpython-*.so'))
        if native and not any('.cpython-312-' in n.name for n in native): continue
        if package.name in pins and not p.name.startswith(pins[package.name]+'-'): continue
        versions.append((tuple(int(n) for n in re.findall(r'\d+',p.name.split('-')[0])), p))
    if versions: sys.path.append(str(max(versions)[1]))
import gltest.direct
print('Using cached genlayer-test 0.29.2:',gltest.direct.__file__,flush=True)
if len(sys.argv)>1: runpy.run_path(sys.argv[1],run_name='__main__')
