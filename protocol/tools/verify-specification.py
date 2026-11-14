#!/usr/bin/env python3
"""Check the revised specification's wire vectors and local Markdown links."""
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


def schedule(r):
    tag = r.number('B')
    assert tag in (1, 2), 'invalid schedule'
    if tag == 2:
        return {'kind': 'OnChange'}
    return {'kind': 'Periodic', **{field: r.time() for field in ('interval', 'phase', 'consumption_delay')}}


def request(r, c):
    def entry():
        s = {'descriptor': r.index(), 'format': r.number('B')}
        assert s['descriptor'] < len(c['sample_descriptors']), 'unknown descriptor'
        if c['sample_descriptors'][s['descriptor']]['kind'] == 10:
            s['reference_space'] = r.number('B')
        return s
    q = {'subscription_id': r.number('I')}
    q['selection'] = {'group': r.index(), 'samples': r.items(entry)}
    q['channel'] = r.number('B')
    q['schedule'] = schedule(r)
    return q


def record(data, c=None):
    r = Reader(data)
    assert r.number('I') == len(data) - 4, 'record length'
    tag = r.number('B')
    assert tag in (*range(1, 10), 12), 'invalid reliable tag'
    return tag, payload(r, tag, c)


def datagram(data):
    r = Reader(data)
    tag = r.number('B')
    assert tag in (9, 10, 11), 'invalid unreliable tag'
    return tag, payload(r, tag)


def payload(r, tag, c=None):
    if tag == 1:
        value = {'supported_versions': r.items(lambda: r.number('H'))}
    elif tag == 2:
        value = {'selected_version': r.number('H')}
    elif tag == 3:
        value = capabilities(r)
    elif tag == 4:
        assert c is not None, 'selection requires capabilities'
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
        value = {'subscription_id': r.number('I'), 'schedule': schedule(r)}
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
    for skeleton in c['skeletons']:
        joints = skeleton['joints']
        assert joints
        for joint in joints:
            assert 0 <= joint['parent'] < len(joints)
            assert 0 <= joint['pose_sample'] < len(desc)
            assert 0 <= joint['rest_pose_sample'] < len(desc)


def validate_schedule(s):
    assert s['kind'] in ('Periodic', 'OnChange')
    if s['kind'] == 'Periodic':
        assert set(s) == {'kind', 'interval', 'phase', 'consumption_delay'}
        assert all(0 <= int(s[field]) < MAX_TIME for field in ('interval', 'phase', 'consumption_delay'))
        assert int(s['interval']) > 0
    else:
        assert set(s) == {'kind'}


def validate_request(c, q):
    selection = q['selection']
    assert 0 <= selection['group'] < len(c['sample_groups'])
    assert q['channel'] in (1, 2)
    validate_schedule(q['schedule'])
    assert selection['samples']
    for s in selection['samples']:
        d = c['sample_descriptors'][s['descriptor']]
        assert d['group'] == selection['group'] and s['format'] in d['supported_formats']
        assert s['reference_space'] in d['supported_spaces'] if d['kind'] == 10 else 'reference_space' not in s


def bitmap(r, count):
    raw = r.take((count + 7) // 8)
    if count % 8:
        assert raw[-1] >> (count % 8) == 0, 'nonzero bitmap padding'
    return [bool(raw[i // 8] & (1 << (i % 8))) for i in range(count)]


def numeric(r, fmt):
    value = r.number(FORMATS[fmt])
    if fmt in (12, 13):
        value /= 255 if fmt == 12 else 65535
    elif fmt in (14, 15):
        value = max(-1, value / (127 if fmt == 14 else 32767))
    return value


def publication(data, c, q):
    r = Reader(data)
    result = {'subscription_id': r.number('I'), 'acquired_at': r.time(), 'predicted_for': r.time(optional=True)}
    assert result['subscription_id'] == q['subscription_id'], 'unknown subscription'
    samples = q['selection']['samples']
    present = bitmap(r, len(samples))
    bits = iter(bitmap(r, sum(ok and s['format'] == 1 for ok, s in zip(present, samples))))
    values = []
    for ok, s in zip(present, samples):
        if not ok:
            values.append(None)
            continue
        kind = c['sample_descriptors'][s['descriptor']]['kind']
        if s['format'] == 1:
            value = next(bits)
        else:
            parts = [numeric(r, s['format']) for _ in range(COMPONENTS[kind])]
            if kind in (8, 9, 10, 16):
                assert all(math.isfinite(v) for v in parts)
            if kind in (8, 16):
                assert 0 <= parts[0] <= 1
            if kind == 9:
                assert all(-1 <= v <= 1 for v in parts)
            if kind == 10:
                tolerance = 1e-5 if s['format'] == 10 else 1e-12
                assert abs(sum(v*v for v in parts[3:]) - 1) <= tolerance
            if s['format'] in (5, 9):
                parts = [str(v) for v in parts]
            value = parts[0] if COMPONENTS[kind] == 1 else parts
        values.append(value)
    result['values'] = values
    r.done()
    return result


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
        tag, value = record(bytes.fromhex(case['hex']), case_caps)
        assert tag == case['tag'] and equivalent(value, expected), case['name']
        if tag == 3:
            validate_capabilities(value)
        if tag == 4:
            validate_request(case_caps, value)
        if tag == 12:
            validate_schedule(value['schedule'])
    for case in fixture['datagrams']:
        raw = bytes.fromhex(case['hex'])
        tag, value = datagram(raw)
        assert tag == case['tag'] and equivalent(value, case['value']), case['name']
        must_reject(lambda: datagram(raw[:-1]))
        must_reject(lambda: datagram(raw + b'\x00'))
        must_reject(lambda: record(struct.pack('<I', len(raw)) + raw))
    for case in fixture['publications']:
        body = bytes.fromhex(case['hex'])
        for name in case['requests']:
            setup = fixture['requests'][name]
            case_caps, q = fixture['capabilities'][setup['capabilities']], setup['value']
            assert equivalent(publication(body, case_caps, q), case['value']), (case['name'], name)
            must_reject(lambda: publication(body[:-1], case_caps, q))
            must_reject(lambda: publication(body + b'\x00', case_caps, q))
        if 'reliable_hex' in case:
            tag, framed_body = record(bytes.fromhex(case['reliable_hex']))
            assert tag == 9 and framed_body == body
        if 'unreliable_hex' in case:
            tag, framed_body = datagram(bytes.fromhex(case['unreliable_hex']))
            assert tag == 9 and framed_body == body
    for case in fixture['formats']:
        raw = bytes.fromhex(case['hex'])
        r = Reader(raw)
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
        delay = (t4-t1)-(t3-t2)
        assert offset == case['server_minus_client_ns'] and delay == case['round_trip_delay_ns']
        assert case['acquired_at_ns'] - offset == case['client_sample_time_ns']
    for case in fixture['time_values']:
        r = Reader(bytes.fromhex(case['hex']))
        assert r.time(optional=case['optional']) == case['value'], case['name']
        r.done()
    for case in fixture['schedule_examples']:
        now, interval, phase, delay = (int(case[k]) for k in ('now', 'interval', 'phase', 'consumption_delay'))
        due = now + (phase - now) % interval
        target = due + delay
        assert (str(due) if due < MAX_TIME else None) == case['next_publication_time']
        assert (str(target) if target < MAX_TIME else None) == case['target_time']
    assert {(q['value']['channel'], q['value']['schedule']['kind']) for q in fixture['requests'].values()} == {(1, 'Periodic'), (1, 'OnChange'), (2, 'Periodic'), (2, 'OnChange')}
    must_reject(lambda: Reader(b'\xff' * 8).time())
    must_reject(lambda: Reader(b'\x02').optional_string())
    for tag in (0, 3, 255):
        must_reject(lambda: schedule(Reader(bytes([tag]))))
    for field in ('interval', 'phase', 'consumption_delay'):
        invalid = {'kind': 'Periodic', 'interval': '10', 'phase': '0', 'consumption_delay': '0', field: str(MAX_TIME)}
        must_reject(lambda: validate_schedule(invalid))
        raw = b'\x01' + b''.join(struct.pack('<Q', int(invalid[k])) for k in ('interval', 'phase', 'consumption_delay'))
        must_reject(lambda: schedule(Reader(raw)))
    must_reject(lambda: validate_schedule({'kind': 'Periodic', 'interval': '0', 'phase': '0', 'consumption_delay': '0'}))
    assert Reader(bytes.fromhex('ffffffff')).index(optional=True) is None
    must_reject(lambda: Reader(bytes.fromhex('ffffffff')).index())
    must_reject(lambda: datagram(b''))
    must_reject(lambda: datagram(b'\x00'))
    must_reject(lambda: datagram(bytes.fromhex(fixture['records'][0]['hex'])[4:]))
    for case in fixture['records']:
        raw = bytes.fromhex(case['hex'])
        must_reject(lambda: record(raw[:-1], c))
        must_reject(lambda: record(raw + b'\x00', c))
    first = bytes.fromhex(fixture['publications'][0]['hex'])
    bad_padding = bytearray(first); bad_padding[20] |= 0x80
    must_reject(lambda: publication(bad_padding, c, fixture['requests']['inputs']['value']))
    bad_time = bytearray(first); bad_time[4:12] = b'\xff' * 8
    must_reject(lambda: publication(bad_time, c, fixture['requests']['inputs']['value']))
    bad_id = bytearray(first); bad_id[:4] = struct.pack('<I', 99)
    must_reject(lambda: publication(bad_id, c, fixture['requests']['inputs']['value']))
    for case in fixture['datagrams']:
        if case['tag'] == 11:
            for offset in (5, 13):
                bad_time = bytearray.fromhex(case['hex']); bad_time[offset:offset+8] = b'\xff' * 8
                must_reject(lambda: datagram(bad_time))
    bad_ref = json.loads(json.dumps(c)); bad_ref['sample_descriptors'][0]['press_count_sample'] = 0
    must_reject(lambda: validate_capabilities(bad_ref))
    check_links(fixture['requirements_commit'])
    examples = (ROOT / 'encoding/examples.md').read_text()
    wire_hex = {case[key] for group in ('records', 'datagrams', 'publications', 'time_values') for case in fixture[group] for key in ('hex', 'reliable_hex', 'unreliable_hex') if key in case}
    for block in re.findall(r'```text\n([0-9a-f \n]+)\n```', examples):
        assert ''.join(block.split()) in wire_hex, 'documentation byte example differs from vectors'
    print(f"Verified {len(fixture['records'])} reliable records, {len(fixture['datagrams'])} clock datagrams, {len(fixture['publications'])} publications, {len(fixture['formats'])} scalar formats, NonMax times, all channel/schedule pairs, clock and schedule arithmetic, malformed data and Markdown links.")

if __name__ == '__main__':
    main()
