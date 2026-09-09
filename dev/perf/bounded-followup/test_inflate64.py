import copy
import unittest
from inflate64 import COMMON, WASM, check_common

class BuildIdentityTests(unittest.TestCase):
    def good(self):
        a = {p: 'same' for p in COMMON}
        b = {**a, WASM: 'intentionally different'}
        return {'baseline': {'common': a}, 'candidate': {'common': b}}

    def test_only_wasm_change_is_accepted(self):
        check_common(self.good())

    def test_same_binary_is_not_a_bitbuffer_comparison(self):
        data = self.good()
        data['candidate']['common'] = copy.deepcopy(data['baseline']['common'])
        with self.assertRaises(ValueError): check_common(data)

    def test_missing_identity_fails(self):
        for arm in ('baseline', 'candidate'):
            for path in COMMON:
                data = self.good(); del data[arm]['common'][path]
                with self.assertRaises(ValueError): check_common(data)

    def test_any_other_changed_identity_fails(self):
        for path in COMMON:
            if path == WASM: continue
            data = self.good(); data['candidate']['common'][path] = 'wrong'
            with self.assertRaises(ValueError): check_common(data)

if __name__ == '__main__': unittest.main()
