"""Generate the matching SDK's generic wrappers for OpenSpades' longest signatures."""
from pathlib import Path
import subprocess
import zipfile
ROOT = Path(__file__).resolve().parent
def generate():
    with zipfile.ZipFile(ROOT / 'vendor/angelscript_2.31.1.zip') as sdk:
        source = sdk.read('sdk/add_on/autowrapper/generator/generateheader.cpp').decode('utf-8-sig')
    source = source.replace('const int max_args = 4;', 'const int max_args = 20;')
    generator = ROOT / 'vendor/generateheader.cpp'
    generator.write_text(source)
    executable = ROOT / 'build/generate-wrappers'
    executable.parent.mkdir(exist_ok=True)
    subprocess.run(['c++','-O2',str(generator),'-o',str(executable)],check=True)
    result = subprocess.check_output([str(executable)])
    target = ROOT / 'vendor/aswrappedcall.h'
    if not target.exists() or target.read_bytes() != result: target.write_bytes(result)
if __name__ == '__main__': generate()
