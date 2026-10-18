"""Build a smaller deployment file with mechanically checked identifier equivalence."""
import ast
import base64
import builtins
from collections import Counter
import copy
import io
from pathlib import Path
import sys
import tokenize
import zlib

ROOT = Path(__file__).resolve().parent


class Rename(ast.NodeTransformer):
    def __init__(self, names):
        self.names = names

    def visit_Name(self, node):
        node.id = self.names.get(node.id, node.id)
        return node

    def visit_arg(self, node):
        node.arg = self.names.get(node.arg, node.arg)
        return self.generic_visit(node)


def compact(text):
    out, previous, level, beginning = [], None, 0, True
    operators = {"**", "//", "<<", ">>", "==", "!=", "<=", ">=", ":=", "->", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "..."}
    words = {tokenize.NAME, tokenize.NUMBER, tokenize.STRING}
    for token in tokenize.generate_tokens(io.StringIO(text).readline):
        if token.type == tokenize.INDENT:
            level += 1
            continue
        if token.type == tokenize.DEDENT:
            level -= 1
            continue
        if token.type in (tokenize.NL, tokenize.ENDMARKER, tokenize.COMMENT):
            continue
        if token.type == tokenize.NEWLINE:
            out.append("\n")
            beginning, previous = True, None
            continue
        if beginning:
            out.append(" " * level)
            beginning = False
        elif previous and ((previous.type in words and token.type in words) or previous.string + token.string in operators):
            out.append(" ")
        out.append(token.string)
        previous = token
    return "".join(out)


def build(source):
    tree = ast.parse(source)
    keep = set(dir(builtins)) | {"self", "cls"}
    counts, bound = Counter(), set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            counts[node.id] += 1
            if isinstance(node.ctx, ast.Store):
                bound.add(node.id)
        elif isinstance(node, ast.arg):
            counts[node.arg] += 1
            bound.add(node.arg)
        elif isinstance(node, ast.Attribute):
            keep.add(node.attr)  # External APIs and persistent field names never change.
        elif isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            keep.add(node.name)
            if isinstance(node, ast.ClassDef):
                keep.update(item.target.id for item in node.body if isinstance(item, ast.AnnAssign) and isinstance(item.target, ast.Name))
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and (node.name == "__init__" or any("gl.public" in ast.unparse(d) for d in node.decorator_list)):
                keep.update(arg.arg for arg in node.args.posonlyargs + node.args.args + node.args.kwonlyargs)
        elif isinstance(node, ast.alias):
            keep.update({node.name, node.name.split(".")[0], node.asname or node.name})
        elif isinstance(node, ast.keyword) and node.arg:
            keep.add(node.arg)
        elif isinstance(node, (ast.Global, ast.Nonlocal)):
            keep.update(node.names)
        elif isinstance(node, ast.ExceptHandler) and node.name:
            keep.add(node.name)
    # No dynamic name lookups: the inverse rename must describe every identifier use.
    if any(isinstance(n, ast.Name) and n.id in {"eval", "exec", "globals", "locals"} for n in ast.walk(tree)):
        raise ValueError("Dynamic name lookup is incompatible with this build")
    names = {}
    for name in sorted(counts, key=lambda n: (-counts[n] * (len(n) - 3), n)):
        if name not in bound or len(name) < 5 or name in keep or name.isupper() or name.startswith("__"):
            continue
        alias = "_" + str(len(names))
        if alias in counts or alias in keep:
            raise ValueError("Generated identifier collision")
        if len(alias) >= len(name):
            continue
        names[name] = alias
    renamed = Rename(names).visit(copy.deepcopy(tree))
    result = source.splitlines()[0] + "\n" + compact(ast.unparse(renamed))
    parsed = ast.parse(result)
    # Check both lexical compaction and the full reversible rename, including closures/f-strings.
    if ast.dump(parsed) != ast.dump(renamed):
        raise ValueError("Compaction changed the Python syntax tree")
    restored = Rename({value: key for key, value in names.items()}).visit(copy.deepcopy(parsed))
    if ast.dump(restored) != ast.dump(tree):
        raise ValueError("Deployment differs from the readable contract")
    compile(parsed, "faultline.deploy.py", "exec")
    return result


if __name__ == "__main__":
    if sys.version_info[:2] != (3, 12):
        raise SystemExit("Build with Python 3.12 so ast.unparse output is reproducible")
    source = (ROOT / "faultline.py").read_text()
    result = build(source)
    target = ROOT / "faultline.deploy.py"
    payload = base64.b64encode(zlib.compress(result.encode(), 9)).decode("ascii")
    bundle = source.splitlines()[0] + "\nimport base64,zlib\nexec(zlib.decompress(base64.b64decode(" + repr(payload) + ")))\n"
    # The loader executes only the immutable build payload, never external input.
    if zlib.decompress(base64.b64decode(payload)).decode() != result:
        raise SystemExit("Bundle does not contain the verified deployment source")
    bundled = ROOT / "faultline.bundle.py"
    if "--check" in sys.argv:
        if not target.exists() or target.read_text() != result or not bundled.exists() or bundled.read_text() != bundle:
            raise SystemExit("Deployment source is stale; run contracts/genlayer/build.py")
    else:
        target.write_text(result)
        bundled.write_text(bundle)
    print(f"GENLAYER-SOURCE:PASS; {len(source.encode())} -> {len(result.encode())} -> {len(bundle.encode())} bytes; reversible identifiers; identical storage, ABI and literal values; exact immutable compressed payload")
