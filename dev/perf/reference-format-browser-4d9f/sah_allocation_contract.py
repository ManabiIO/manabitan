"""Source-bound exact SAH allocation contract for a new schema parent."""

def exact_parent_allocation(contract, dictionary):
    if contract.get('schemaVersion') != 2:
        raise ValueError('Expected the source-bound allocation contract version')
    case = contract['dictionaries'][dictionary]
    if dictionary != 'vndb':
        if 'sahAllocationUnits' in case:
            raise ValueError('Unexpected SAH allocation override')
        return None
    observation = contract['parentAllocationObservation']
    if observation['source'] != contract['parent']:
        raise ValueError('Allocation observation belongs to another parent')
    if observation['status'] != 'observed-parent-only' or observation['importFlags'] is not None or observation['timingEligible'] is not False:
        raise ValueError('Expected an independent default-flag parent observation')
    units = observation['activeSahUnits']
    if type(units) is not int or units <= 1 or observation['activeSahBytes'] != units * 4096:
        raise ValueError('Invalid aligned parent allocation')
    if observation['allSahSizes'] != [4096] * 7 + [units * 4096]:
        raise ValueError('Expected seven empty SAH files and one active file')
    expected = case['sahAllocationUnits']
    if not isinstance(expected, list) or len(expected) != 2 or any(type(value) is not int for value in expected) or expected != [units, units]:
        raise ValueError('An exact parent allocation is required; a range is forbidden')
    return list(expected)
