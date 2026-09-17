from pathlib import Path
import hashlib,sys
p=Path(sys.argv[1])
s=p.read_text()
assert hashlib.sha256(p.read_bytes()).hexdigest()=='70ef1cb988f56eb0b662c3d19f5b1cb5b5c843b63a872f23e3a8c79405884e29'
a=s.index('const variants = {')
b=s.index('\nconst selected',a)
s=s[:a]+'''const common = process.env.CRC_WITH_LIBDEFLATE === '1' ? {experimentalLibdeflate: true} : {}
const variants = {
    control: {},
    slice16: {experimentalCrcSlicing16: true},
    slice32: {experimentalCrcSlicing32: true},
    braid: {experimentalCrcBraided16: true},
}'''+s[b:]
s=s.replace("'control,inflate'", "'control,slice16,slice32,braid'")
s=s.replace("flags: arm === 'A' ? {} : variants[id]", "flags: {...common, ...(arm === 'A' ? {} : variants[id])}")
s=s.replace("base: '8191f6c6997d7afc5d54e647e93af6def48dfa98'", "base: '51c06f03da22a416d331a9c72bf76f8435666f50', commonFlags: common")
assert s.count('flags: {...common,')==2
p.with_name('crc-abba.mjs').write_text(s)
print('Prepared identical timing and validation driver with CRC flags and explicit common backend')
