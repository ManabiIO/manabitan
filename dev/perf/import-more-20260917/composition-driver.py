from pathlib import Path
import sys
p=Path(sys.argv[1]);s=p.read_text()
old='const plan = []\n';assert s.count(old)==1
s=s.replace(old,"const baseFlags = {experimentalLibdeflate: true}\nassert.equal(snapshotTermBankExperiments(baseFlags).experimentalLibdeflate, true)\nconst plan = []\n")
old="flags: arm === 'A' ? {} : variants[id]";assert s.count(old)==2
s=s.replace(old,"flags: {...baseFlags, ...(arm === 'A' ? {} : variants[id])}")
old="dictionary, fixture, blocks, identities";assert s.count(old)==1
s=s.replace(old,"dictionary, fixture, blocks, baseFlags, identities")
Path(sys.argv[2]).write_text(s)
