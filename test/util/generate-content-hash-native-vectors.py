"""Regenerate native XXH32 test vectors; development-only libxxhash dependency."""
import ctypes
import ctypes.util
import json
from pathlib import Path

library_path = ctypes.util.find_library('xxhash')
if not library_path:
    raise RuntimeError('A native xxHash library is required to regenerate the oracle')
lib = ctypes.CDLL(library_path)
lib.XXH32.argtypes = [ctypes.c_void_p, ctypes.c_size_t, ctypes.c_uint32]
lib.XXH32.restype = ctypes.c_uint32
lib.XXH_versionNumber.restype = ctypes.c_uint
vectors = []
lengths = list(range(0, 513)) + [1023,1024,1025,4095,4096,4097,65535,65536,65537,1048576]
for length in lengths:
    for salt in [0,17,63,255]:
        data = bytes((((i*131 + (i>>3)*17 + salt) ^ ((i*7)>>2)) & 255) for i in range(length))
        buf = ctypes.create_string_buffer(data)
        pair = [int(lib.XXH32(buf, length, seed)) for seed in [0x811c9dc5,0x9e3779b9]]
        if not any(pair):
            pair[0] = 1
        vectors.append({'length':length,'salt':salt,'pair':pair})
path = Path(__file__).resolve().parents[2] / 'test/data/content-hash-native-vectors.json'
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(json.dumps({'oracle':'Native libxxhash XXH32 via ctypes','library':library_path,'version':lib.XXH_versionNumber(),'recipe':'(((i*131 + (i>>3)*17 + salt) ^ ((i*7)>>2)) & 255)','vectors':vectors}, separators=(',',':'))+'\n')
print(f'{len(vectors)} native vectors, xxHash {lib.XXH_versionNumber()}, {path}')
