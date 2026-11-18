#!/usr/bin/env python3
"""Check the revised specification's wire vectors and local Markdown links."""
import copy
import json
import math
import re
import struct
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / 'testdata/specification-v1.json'
FORMATS = {2: 'B', 3: 'H', 4: 'I', 5: 'Q', 6: 'b', 7: 'h', 8: 'i', 9: 'q', 10: 'f', 11: 'd', 12: 'B', 13: 'H', 14: 'b', 15: 'h'}
COMPONENTS = {kind: (7 if kind == 10 else 2 if kind == 9 else 1) for kind in range(1, 17)}
ALLOWED = {1: set(range(1, 16)), 2: {1}, 3: {2, 3, 4, 5}, 4: {2, 3, 4, 5}, 5: {1}, 6: {2, 3, 4, 5}, 7: {2, 3, 4, 5}, 8: {10, 11, 12, 13}, 9: {10, 11, 14, 15}, 10: {10, 11}, 11: {2, 3, 4, 5}, 12: {1}, 13: {1}, 14: {1}, 15: {1}, 16: {10, 11, 12, 13}}
TAILS = {2: [('press_count_sample', 3), ('release_count_sample', 4)], 5: [('touch_count_sample', 6), ('untouch_count_sample', 7)], 10: [('position_valid_sample', 12), ('orientation_valid_sample', 13), ('position_tracked_sample', 14), ('orientation_tracked_sample', 15), ('confidence_sample', 16)]}
MAX_TIME = 0xffffffffffffffff
SEQUENCES = {1: ('H', 16), 2: ('I', 32), 3: ('Q', 64)}
TIMING = ('interval', 'phase', 'prediction_offset')

class Reader:
    def __init__(self, data):
        self.data, self.pos = data, 0

    def take(self, count):
        assert count >= 0 and self.pos + count <= len(self.data), 'truncated value'
        value = self.data[self.pos:self.pos + count]
        self.pos += count
        return value

    def number(self, fmt):
        return struct.unpack('<' + fmt, self.take(struct.calcsize(fmt)))[0]

    def string(self):
        return self.take(self.number('I')).decode('utf-8')

    def optional_string(self):
        present = self.number('B')
        assert present in (0, 1), 'invalid string presence tag'
        return self.string() if present else None

    def time(self, optional=False):
        value = self.number('Q')
        if value == MAX_TIME:
            assert optional, 'absent required time'
            return None
        return str(value)

    def index(self, optional=False):
        value = self.number('I')
        if value == 0xffffffff:
            assert optional, 'absent required index'
            return None
        return value

    def items(self, read):
        count = self.number('I')
        assert count <= len(self.data) - self.pos, 'impossible list count'
        return [read() for _ in range(count)]

    def done(self):
        assert self.pos == len(self.data), 'trailing bytes'


def descriptor(r):
    d = dict(zip(('id', 'name', 'description'), (r.string() for _ in range(3))))
    d['kind'] = r.number('B')
    d['supported_formats'] = r.items(lambda: r.number('B'))
    d['group'] = r.index()
    if d['kind'] == 10:
        d['supported_spaces'] = r.items(lambda: r.number('B'))
    for field, _ in TAILS.get(d['kind'], []):
        d[field] = r.index(optional=True)
    if d['kind'] == 11:
        d['revision_of'] = r.index()
    assert d['kind'] in COMPONENTS, 'invalid kind'
    return d


def capabilities(r):
    groups = r.items(lambda: {'max_sample_rate_hz': r.number('f')})
    desc = r.items(lambda: descriptor(r))
    skeletons = r.items(lambda: {'joints': r.items(lambda: dict(zip(('parent', 'pose_sample', 'rest_pose_sample'), (r.index() for _ in range(3)))))})
    return {'sample_groups': groups, 'sample_descriptors': desc, 'skeletons': skeletons}


def timing(r):
    return {field: r.time() for field in TIMING}


def request(r, c):
    def binding():
        value = {'descriptor': r.index(), 'format': r.number('B')}
        assert value['descriptor'] < len(c['sample_descriptors']), 'unknown descriptor'
        if c['sample_descriptors'][value['descriptor']]['kind'] == 10:
            value['reference_space'] = r.number('B')
        return value
    value = {'subscription_id': r.number('I'), 'group': r.index(), 'channel': r.number('B'), **timing(r)}
    sequence_format = r.number('B')
    assert sequence_format in (0, 1, 2, 3), 'invalid sequence format'
    value['sequence_number_format'] = sequence_format or None
    value['bundles'] = r.items(lambda: r.items(binding))
    return value


def sequence(r, q):
    fmt = q['sequence_number_format']
    return str(r.number(SEQUENCES[fmt][0])) if fmt is not None else None


def acknowledgment(r, q):
    assert q is not None and q['sequence_number_format'] is not None, 'unsequenced subscription'
    value = {'subscription_id': r.number('I')}
    assert value['subscription_id'] == q['subscription_id'], 'unknown subscription'
    value['sequence_number'] = sequence(r, q)
    return value


def message(data, c=None, q=None):
    assert 0 < len(data), 'empty message'
    r = Reader(data)
    tag = r.number('B')
    assert 1 <= tag <= 13, 'invalid message tag'
    return tag, payload(r, tag, c, q)


def payload(r, tag, c=None, q=None):
    if tag == 1:
        versions = r.items(lambda: r.number('H'))
        assert versions and 0 not in versions and len(set(versions)) == len(versions)
        value = {'supported_versions': versions}
    elif tag == 2:
        value = {'selected_version': r.number('H')}
    elif tag == 3:
        value = capabilities(r)
    elif tag == 4:
        assert c is not None, 'bindings require capabilities'
        value = request(r, c)
    elif tag in (5, 7):
        value = {'subscription_id': r.number('I')}
    elif tag == 6:
        value = {'subscription_id': r.number('I'), 'reason': r.optional_string()}
    elif tag == 8:
        value = {'subscription_id': r.number('I'), 'reason': r.string()}
    elif tag == 9:
        value = r.take(len(r.data) - r.pos)
    elif tag == 10:
        value = {'request_id': r.number('I')}
    elif tag == 11:
        value = {'request_id': r.number('I'), 'received_at': r.time(), 'sent_at': r.time()}
    elif tag == 12:
        value = {'subscription_id': r.number('I'), **timing(r)}
    elif tag == 13:
        value = acknowledgment(r, q)
    else:
        raise AssertionError('unknown tag')
    r.done()
    return value


def validate_capabilities(c):
    groups, desc = c['sample_groups'], c['sample_descriptors']
    assert all(math.isfinite(g['max_sample_rate_hz']) and g['max_sample_rate_hz'] > 0 for g in groups)
    assert len({d['id'] for d in desc}) == len(desc)
    for d in desc:
        assert 0 <= d['group'] < len(groups)
        assert d['supported_formats'] and set(d['supported_formats']) <= ALLOWED[d['kind']]
        if d['kind'] == 10:
            assert d['supported_spaces'] and set(d['supported_spaces']) <= set(range(1, 7))
        for field, kind in TAILS.get(d['kind'], []):
            index = d[field]
            if index is not None:
                assert 0 <= index < len(desc) and desc[index]['kind'] == kind
        if d['kind'] == 11:
            assert 0 <= d['revision_of'] < len(groups)
    parent_frames = {}
    for skeleton in c['skeletons']:
        joints = skeleton['joints']
        assert joints
        for joint in joints:
            assert 0 <= joint['parent'] < len(joints)
            for field in ('pose_sample', 'rest_pose_sample'):
                index = joint[field]
                assert 0 <= index < len(desc) and desc[index]['kind'] == 10, 'joint reference is not a pose'
        for start, joint in enumerate(joints):
            seen, current = set(), start
            while joints[current]['parent'] != current:
                assert current not in seen, 'non-root parent cycle'
                seen.add(current)
                current = joints[current]['parent']
            for field in ('pose_sample', 'rest_pose_sample'):
                parent_frames.setdefault(joint[field], set()).add(joints[joint['parent']][field])
    for index, d in enumerate(desc):
        if d['kind'] == 10 and 5 in d['supported_spaces']:
            assert len(parent_frames.get(index, set())) == 1, 'missing or conflicting parent frame'


def validate_timing(q):
    assert all(0 <= int(q[field]) < MAX_TIME for field in TIMING)
    assert int(q['interval']) > 0, 'zero interval'


class RequestRejected(AssertionError):
    """Readable, well-typed Subscribe that cannot be served."""


def validate_request(c, q, limits=None):
    assert 0 <= q['group'] < 0xffffffff
    assert q['channel'] in (1, 2), 'invalid channel enum'
    validate_timing(q)
    assert q['sequence_number_format'] in (None, 1, 2, 3)
    assert q['bundles'], 'no bundles'
    assert len(q['bundles']) == 1 or q['sequence_number_format'] is not None, 'bundles require sequences'
    # Validate all type constraints before any admission rejection.
    for bundle in q['bundles']:
        for binding in bundle:
            assert 0 <= binding['descriptor'] < len(c['sample_descriptors']), 'unknown descriptor'
            assert binding['format'] in range(1, 16), 'invalid format enum'
            d = c['sample_descriptors'][binding['descriptor']]
            if d['kind'] == 10:
                assert binding['reference_space'] in range(1, 7), 'invalid space enum'
            else:
                assert 'reference_space' not in binding
    if q['group'] >= len(c['sample_groups']):
        raise RequestRejected('unknown group')
    for bundle in q['bundles']:
        for binding in bundle:
            d = c['sample_descriptors'][binding['descriptor']]
            if d['group'] != q['group'] or binding['format'] not in d['supported_formats']:
                raise RequestRejected('unsupported membership or format')
            if d['kind'] == 10 and binding['reference_space'] not in d['supported_spaces']:
                raise RequestRejected('unsupported space')
    limits = limits or {}
    if 1 + publication_size(c, q) > limits.get('max_publication_bytes', math.inf):
        raise RequestRejected('publication too large')
    if 1_000_000_000 / int(q['interval']) > limits.get('max_publication_rate_hz', math.inf):
        raise RequestRejected('publication rate unavailable')


def message_outcome(data, c, q, case):
    """Check the specified externally observable result, not just parse failure."""
    channel = case['channel']
    tag = data[0] if data else None
    error = 'discard_message' if channel == 1 or tag == 9 else 'close_connection'
    if len(data) > case.get('limits', {}).get('max_message_bytes', math.inf):
        return error
    try:
        if tag != 9 and tag is not None:
            assert channel == (1 if tag in (10, 11, 13) else 2), 'wrong control channel'
        tag, value = message(data, c, q)
        if tag == 3:
            validate_capabilities(value)
        elif tag == 4:
            validate_request(c, value, case.get('limits'))
        elif tag == 9:
            assert q is not None and q['channel'] == channel, 'wrong publication channel or unknown id'
            publication(value, c, q)
        elif tag == 12:
            validate_timing(value)
            if q is None or value['subscription_id'] != q['subscription_id']:
                return 'ignore_update'
            if case.get('subscription_state') == 'ended':
                return 'ignore_update'
            if 1_000_000_000 / int(value['interval']) > case.get('limits', {}).get('max_publication_rate_hz', math.inf):
                return 'terminate_subscription'
        elif tag == 13 and 'sent_sequences' in case:
            if value['sequence_number'] not in case['sent_sequences']:
                return 'discard_message'
    except RequestRejected:
        return 'reject_subscription'
    except (AssertionError, IndexError, KeyError, UnicodeError, struct.error):
        return error
    return 'accept_message'


def bitmap(r, count):
    raw = r.take((count + 7) // 8)
    return [bool(raw[i // 8] & (1 << (i % 8))) for i in range(count)]


def numeric(r, fmt):
    value = r.number(FORMATS[fmt])
    if fmt in (12, 13):
        value /= 255 if fmt == 12 else 65535
    elif fmt in (14, 15):
        value = max(-1, value / (127 if fmt == 14 else 32767))
    return value


def bundle_values(r, c, bindings):
    bits = iter(bitmap(r, sum(binding['format'] == 1 for binding in bindings)))
    values = []
    for binding in bindings:
        kind = c['sample_descriptors'][binding['descriptor']]['kind']
        fmt = binding['format']
        if fmt == 1:
            value = next(bits)
        else:
            parts = [numeric(r, fmt) for _ in range(COMPONENTS[kind])]
            if kind in (8, 9, 10, 16):
                assert all(math.isfinite(v) for v in parts), 'nonfinite value'
            if kind in (8, 16):
                assert 0 <= parts[0] <= 1, 'normalized value out of range'
            if kind == 9:
                assert all(-1 <= v <= 1 for v in parts), 'axis out of range'
            if kind == 10:
                tolerance = 1e-5 if fmt == 10 else 1e-12
                assert abs(sum(v*v for v in parts[3:]) - 1) <= tolerance, 'nonunit quaternion'
            if fmt in (5, 9):
                parts = [str(v) for v in parts]
            value = parts[0] if COMPONENTS[kind] == 1 else parts
        values.append(value)
    return values


def publication(data, c, q):
    r = Reader(data)
    result = {'subscription_id': r.number('I'), 'acquired_at': r.time(), 'predicted_for': r.time(optional=True)}
    assert result['subscription_id'] == q['subscription_id'], 'unknown subscription'
    result['sequence_number'] = sequence(r, q)
    presence = [True] + bitmap(r, len(q['bundles']) - 1)
    result['bundles'] = [bundle_values(r, c, bindings) if present else None
                         for bindings, present in zip(q['bundles'], presence)]
    r.done()
    return result


def publication_size(c, q, included=None):
    if included is None:
        included = range(len(q['bundles']))
    width = 0 if q['sequence_number_format'] is None else SEQUENCES[q['sequence_number_format']][1] // 8
    size = 20 + width + (len(q['bundles']) - 1 + 7) // 8
    for j in included:
        bindings = q['bundles'][j]
        size += (sum(b['format'] == 1 for b in bindings) + 7) // 8
        size += sum(COMPONENTS[c['sample_descriptors'][b['descriptor']]['kind']] * struct.calcsize(FORMATS[b['format']])
                    for b in bindings if b['format'] != 1)
    return size


def sequence_order(fmt, current, previous):
    modulus = 1 << SEQUENCES[fmt][1]
    delta = (int(current) - int(previous)) % modulus
    if delta == 0:
        return 'duplicate'
    if delta == modulus // 2:
        return 'ambiguous'
    return 'newer' if delta < modulus // 2 else 'older'


def check_acknowledgment_trace(trace):
    """Small behavioral model; revisions and history are local, never serialized."""
    states, revisions, pending, history = None, [], set(), {}
    next_sequence = int(trace['initial_sequence'])
    fmt = trace['sequence_format']
    for step in trace['steps']:
        if 'acquire' in step:
            acquired = step['acquire']
            if states is None:
                revisions = [0] * len(acquired)
                pending = set(range(1, len(acquired) + 1))
            else:
                assert len(acquired) == len(states)
                for j, (old, new) in enumerate(zip(states, acquired), 1):
                    if old != new:
                        revisions[j - 1] += 1
                        pending.add(j)
            states = acquired
        elif 'publish' in step:
            if not trace['continuous'] and not pending:
                assert step['publish'] is None
                continue
            included = [0] + sorted(pending)
            assert step['publish'] == {'sequence': str(next_sequence) if fmt else None, 'included': included}
            if fmt:
                assert next_sequence not in history, 'ambiguous outstanding sequence reuse'
                history[next_sequence] = {j: revisions[j - 1] for j in pending}
                next_sequence = (next_sequence + 1) % (1 << SEQUENCES[fmt][1])
                assert trace['history_limit'] < (1 << (SEQUENCES[fmt][1] - 1))
                while len(history) > trace['history_limit']:
                    del history[next(iter(history))]
        elif 'ack' in step:
            for j, revision in history.pop(int(step['ack']), {}).items():
                if revisions[j - 1] == revision:
                    pending.discard(j)
        else:
            raise AssertionError('unknown trace step')
        if 'pending' in step:
            assert sorted(pending) == step['pending'], (trace['name'], step)


def check_receive_trace(trace):
    applied = {}
    newest_wire = newest_position = None
    fmt = trace['sequence_format']
    modulus = 1 << SEQUENCES[fmt][1]
    for step in trace['steps']:
        current = int(step['sequence'])
        updated = []
        if newest_wire is None:
            position = current
            newest_wire, newest_position = current, position
        else:
            order = sequence_order(fmt, current, newest_wire)
            if order == 'ambiguous':
                assert step['apply'] == [] and not step['ack']
                continue
            delta = (current - newest_wire) % modulus
            position = newest_position + (delta if delta < modulus // 2 else delta - modulus)
            if order == 'newer':
                newest_wire, newest_position = current, position
        for j in step['bundles']:
            if j not in applied or position > applied[j]:
                applied[j] = position
                updated.append(j)
        assert updated == step['apply'], (trace['name'], step)
        assert step['ack'] or not any(j > 0 for j in step['bundles']), 'missing required ACK'
        if not step['ack']:
            continue
        # Valid duplicates/older arrivals with on-change bundles require an ACK.
        raw = struct.pack('<I', 7) + struct.pack('<' + SEQUENCES[fmt][0], current)
        r = Reader(raw)
        assert acknowledgment(r, {'subscription_id': 7, 'sequence_number_format': fmt}) == {
            'subscription_id': 7, 'sequence_number': step['sequence']}
        r.done()


def check_replacement_trace(trace):
    active, pending, received = 'old', None, []
    queued_ack = trace.get('queued_ack', False)
    for step in trace['steps']:
        event = step['event']
        if event == 'request':
            assert pending is None
            pending, queued_ack = 'new', False
        elif event == 'server_accept':
            assert step['notifications'] == ['SubscriptionAccepted']
        elif event == 'publication':
            decoded = active is not None and not (pending and step['channel'] == 1)
            assert decoded == step['decode']
            assert (active if decoded else None) == step['layout']
            ack = decoded and pending is None and step.get('on_change', True)
            assert ack == step['ack']
            if decoded:
                received.append(step['sequence'])
        elif event == 'accepted':
            assert pending is not None
            active, pending, received = pending, None, []
        elif event == 'rejected':
            assert pending is not None
            pending = None
        elif event == 'terminated':
            active, received = None, []
        else:
            raise AssertionError('unknown replacement event')
        if 'active' in step:
            assert active == step['active']
        if 'pending' in step:
            assert (pending is not None) == step['pending']
        if 'received' in step:
            assert received == step['received']
        if 'queued_ack' in step:
            assert queued_ack == step['queued_ack']


def equivalent(a, b):
    if isinstance(a, dict):
        return isinstance(b, dict) and a.keys() == b.keys() and all(equivalent(a[k], b[k]) for k in a)
    if isinstance(a, list):
        return isinstance(b, list) and len(a) == len(b) and all(equivalent(x, y) for x, y in zip(a, b))
    if isinstance(a, float) and isinstance(b, (int, float)):
        return math.isclose(a, b, rel_tol=1e-7, abs_tol=1e-12)
    return a == b


def must_reject(call):
    try:
        call()
    except (AssertionError, IndexError, KeyError, UnicodeError, struct.error):
        return
    raise AssertionError('malformed input accepted')


def check_links(commit):
    anchors = {}
    for path in ROOT.rglob('*.md'):
        raw = path.read_bytes()
        assert b'\r' not in raw and raw.endswith(b'\n'), path
        text = raw.decode('utf-8')
        for target in re.findall(r'\]\(([^)]+)\)', text):
            if '://' in target:
                continue
            name, _, fragment = target.partition('#')
            destination = (path.parent / name).resolve() if name else path
            if 'design/requirements/' in destination.as_posix():
                relative = destination.relative_to(ROOT.parent).as_posix()
                result = subprocess.run(['git', 'cat-file', '-e', f'{commit}:{relative}'], capture_output=True)
                assert result.returncode == 0, (path, target)
            else:
                assert destination.exists(), (path, target)
            if fragment and destination.suffix == '.md' and 'design/requirements/' not in destination.as_posix():
                if destination not in anchors:
                    headings = re.findall(r'^#{1,6}\s+(.+)$', destination.read_text(), re.M)
                    anchors[destination] = {re.sub(r'[^\w\- ]', '', h.lower()).replace(' ', '-') for h in headings}
                assert fragment in anchors[destination], (path, target)


def main():
    fixture = json.loads(FIXTURE.read_text())
    c = fixture['capabilities']['device']
    for capabilities_set in fixture['capabilities'].values():
        validate_capabilities(capabilities_set)
    for case in fixture['capability_cases']:
        candidate = copy.deepcopy(c)
        candidate['skeletons'] = case['skeletons']
        for index, spaces in case.get('descriptor_spaces', {}).items():
            candidate['sample_descriptors'][int(index)]['supported_spaces'] = spaces
        if case['valid']:
            validate_capabilities(candidate)
        else:
            must_reject(lambda: validate_capabilities(candidate))
    for setup in fixture['requests'].values():
        validate_request(fixture['capabilities'][setup['capabilities']], setup['value'])
    for case in fixture['records']:
        case_caps = c
        if case['tag'] == 3:
            expected = fixture['capabilities'][case['capabilities']]
            expected = {**expected, 'skeletons': case.get('skeletons', expected['skeletons'])}
        elif case['tag'] == 4:
            setup = fixture['requests'][case['request']]
            case_caps, expected = fixture['capabilities'][setup['capabilities']], setup['value']
        else:
            expected = case['value']
        raw = bytes.fromhex(case['hex'])
        tag, value = message(raw, case_caps)
        assert tag == case['tag'] and equivalent(value, expected), case['name']
        if tag == 3:
            validate_capabilities(value)
        if tag == 4:
            validate_request(case_caps, value)
        if tag == 12:
            validate_timing(value)
        must_reject(lambda: message(raw[:-1], case_caps))
        must_reject(lambda: message(raw + b'\x00', case_caps))
    for case in fixture['datagrams']:
        raw = bytes.fromhex(case['hex'])
        q = fixture['requests'][case['request']]['value'] if 'request' in case else None
        tag, value = message(raw, q=q)
        assert tag == case['tag'] and equivalent(value, case['value']), case['name']
        must_reject(lambda: message(raw[:-1], q=q))
        must_reject(lambda: message(raw + b'\x00', q=q))
        assert tag in (10, 11, 13), 'unreliable control routing'
    for case in fixture['publications']:
        tag, body = message(bytes.fromhex(case['hex']))
        assert tag == 9
        for name in case['requests']:
            setup = fixture['requests'][name]
            case_caps, q = fixture['capabilities'][setup['capabilities']], setup['value']
            assert equivalent(publication(body, case_caps, q), case['value']), (case['name'], name)
            included = [j for j, values in enumerate(case['value']['bundles']) if values is not None]
            assert len(body) == publication_size(case_caps, q, included)
            assert len(body) <= publication_size(case_caps, q)
            must_reject(lambda: publication(body[:-1], case_caps, q))
            must_reject(lambda: publication(body + b'\x00', case_caps, q))
    for case in fixture['message_outcomes']:
        setup = fixture['requests'][case['request']] if 'request' in case else None
        case_caps = fixture['capabilities'][setup['capabilities']] if setup else c
        q = setup['value'] if setup else None
        if case.get('subscription_state') == 'ended':
            tag, value = message(bytes.fromhex(case['hex']), case_caps, q)
            assert tag == 12 and q is not None and value['subscription_id'] == q['subscription_id']
        actual = message_outcome(bytes.fromhex(case['hex']), case_caps, q, case)
        assert actual == case['outcome'], (case['name'], actual, case['outcome'])
    for case in fixture['formats']:
        r = Reader(bytes.fromhex(case['hex']))
        value = bitmap(r, 1)[0] if case['format'] == 1 else numeric(r, case['format'])
        expected = case['decoded']
        if expected in ('true', 'false'):
            assert value == (expected == 'true')
        elif case['format'] in (2, 3, 4, 5, 6, 7, 8, 9):
            assert value == int(expected)
        else:
            assert math.isclose(value, float(expected), rel_tol=1e-12, abs_tol=1e-15)
        r.done()
    for case in fixture['clock_examples']:
        t1, t2, t3, t4 = case['timestamps_ns']
        offset = ((t2-t1)+(t3-t4))/2
        delay = max(case['precision_ns'], (t4-t1)-(t3-t2))
        assert offset == case['server_minus_client_ns'] and delay == case['round_trip_delay_ns']
        assert case['acquired_at_ns'] - offset == case['client_sample_time_ns']
    for case in fixture['time_values']:
        r = Reader(bytes.fromhex(case['hex']))
        assert r.time(optional=case['optional']) == case['value'], case['name']
        r.done()
    for case in fixture['schedule_examples']:
        now, interval, phase, offset = (int(case[k]) for k in ('now', 'interval', 'phase', 'prediction_offset'))
        due = now + (phase - now) % interval
        target = due + offset
        assert (str(due) if due < MAX_TIME else None) == case['next_publication_time']
        assert (str(target) if target < MAX_TIME else None) == case['target_time']
    for case in fixture['initial_target_examples']:
        target = int(case['opportunity_time']) + int(case['prediction_offset'])
        assert (str(target) if target < MAX_TIME else None) == case['requested_target']
    for case in fixture['sequence_examples']:
        assert sequence_order(case['format'], case['current'], case['previous']) == case['order']
    for trace in fixture['acknowledgment_traces']:
        check_acknowledgment_trace(trace)
    for trace in fixture['receive_traces']:
        check_receive_trace(trace)
    for trace in fixture['replacement_traces']:
        check_replacement_trace(trace)
    assert {q['value']['channel'] for q in fixture['requests'].values()} == {1, 2}
    assert {q['value']['sequence_number_format'] for q in fixture['requests'].values()} == {None, 1, 2, 3}
    for field in TIMING:
        invalid = {'interval': '10', 'phase': '0', 'prediction_offset': '0', field: str(MAX_TIME)}
        must_reject(lambda: validate_timing(invalid))
        raw = b''.join(struct.pack('<Q', int(invalid[k])) for k in TIMING)
        must_reject(lambda: timing(Reader(raw)))
    must_reject(lambda: Reader(b'\xff' * 8).time())
    must_reject(lambda: Reader(b'\x02').optional_string())
    assert Reader(bytes.fromhex('ffffffff')).index(optional=True) is None
    must_reject(lambda: Reader(bytes.fromhex('ffffffff')).index())
    first = bytes.fromhex(fixture['publications'][0]['hex'])[1:]
    ignored_padding = bytearray(first); ignored_padding[20] |= 0x80
    assert publication(ignored_padding, c, fixture['requests']['inputs']['value']) == publication(first, c, fixture['requests']['inputs']['value'])
    for case in fixture['datagrams']:
        if case['tag'] == 11:
            for offset in (5, 13):
                bad_time = bytearray.fromhex(case['hex']); bad_time[offset:offset+8] = b'\xff' * 8
                must_reject(lambda: message(bad_time))
    bad_ref = copy.deepcopy(c); bad_ref['sample_descriptors'][0]['press_count_sample'] = 0
    must_reject(lambda: validate_capabilities(bad_ref))
    check_links(fixture['requirements_commit'])
    for path in ROOT.rglob('*'):
        if path.is_file() and path.suffix in ('.md', '.json', '.py'):
            raw = path.read_bytes()
            assert b'\r' not in raw and raw.endswith(b'\n'), path
    examples = (ROOT / 'encoding/examples.md').read_text()
    wire_hex = {case['hex'] for group in ('records', 'datagrams', 'publications', 'time_values') for case in fixture[group]}
    for block in re.findall(r'```text\n([0-9a-f \n]+)\n```', examples):
        assert ''.join(block.split()) in wire_hex, 'documentation byte example differs from vectors'
    print(f"Verified {len(fixture['records'])} reliable messages, {len(fixture['datagrams'])} unreliable controls, "
          f"{len(fixture['publications'])} publications, {len(fixture['message_outcomes'])} message outcomes, "
          f"{len(fixture['formats'])} scalar formats, all sequence widths, exact acknowledgment traces, "
          "per-bundle ordering, replacement races, capability references, clock/schedule arithmetic, NonMax times, line endings and Markdown links.")


if __name__ == '__main__':
    main()
