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


def request(r):
    q = {'subscription_id': r.number('I'), 'group': r.index(), 'delivery_mode': r.number('B'), 'publication_rate_hz': r.number('f')}
    q['samples'] = r.items(lambda: {'descriptor': r.index(), 'format': r.number('B'), 'reference_space': r.number('B')})
    return q


def record(data):
    r = Reader(data)
    assert r.number('I') == len(data) - 4, 'record length'
    tag = r.number('B')
    assert 1 <= tag <= 9, 'invalid reliable tag'
    return tag, payload(r, tag)


def datagram(data):
    r = Reader(data)
    tag = r.number('B')
    assert tag in (9, 10, 11), 'invalid unreliable tag'
    return tag, payload(r, tag)


def payload(r, tag):
    if tag == 1:
        value = {'supported_versions': r.items(lambda: r.number('H'))}
    elif tag == 2:
        value = {'selected_version': r.number('H')}
    elif tag == 3:
        value = capabilities(r)
    elif tag == 4:
        value = request(r)
    elif tag in (5, 7):
        value = {'subscription_id': r.number('I'), 'generation': r.number('I')}
    elif tag == 6:
        value = {'subscription_id': r.number('I'), 'reason': r.string()}
    elif tag == 8:
        value = {'subscription_id': r.number('I'), 'generation': r.number('I'), 'reason': r.string()}
    elif tag == 9:
        value = r.take(len(r.data) - r.pos)
    elif tag == 10:
        value = {'request_id': r.number('I')}
    elif tag == 11:
        value = {'request_id': r.number('I'), 'received_at_ns': str(r.number('Q')), 'sent_at_ns': str(r.number('Q'))}
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
            assert d['supported_spaces'] and set(d['supported_spaces']) <= set(range(1, 6))
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


def validate_request(c, q):
    assert 0 <= q['group'] < len(c['sample_groups'])
    assert q['delivery_mode'] in (1, 2)
    assert math.isfinite(q['publication_rate_hz']) and q['publication_rate_hz'] > 0
    assert q['samples']
    for s in q['samples']:
        d = c['sample_descriptors'][s['descriptor']]
        assert d['group'] == q['group'] and s['format'] in d['supported_formats']
        assert s['reference_space'] in d['supported_spaces'] if d['kind'] == 10 else s['reference_space'] == 0


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
    result = {'subscription_id': r.number('I'), 'generation': r.number('I'), 'acquired_at_ns': str(r.number('Q'))}
    present = bitmap(r, len(q['samples']))
    bits = iter(bitmap(r, sum(ok and s['format'] == 1 for ok, s in zip(present, q['samples']))))
    values = []
    for ok, s in zip(present, q['samples']):
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
    c = fixture['capabilities']
    validate_capabilities(c)
    for q in fixture['requests'].values():
        validate_request(c, q)
    for case in fixture['records']:
        tag, value = record(bytes.fromhex(case['hex']))
        assert tag == case['tag'] and equivalent(value, case['value']), case['name']
        if tag == 3:
            validate_capabilities(value)
    for case in fixture['datagrams']:
        raw = bytes.fromhex(case['hex'])
        tag, value = datagram(raw)
        assert tag == case['tag'] and equivalent(value, case['value']), case['name']
        must_reject(lambda: datagram(raw[:-1]))
        must_reject(lambda: datagram(raw + b'\x00'))
        must_reject(lambda: record(struct.pack('<I', len(raw)) + raw))
    for case in fixture['publications']:
        q = fixture['requests'][case['request']]
        body = bytes.fromhex(case['hex'])
        assert equivalent(publication(body, c, q), case['value']), case['name']
        if 'reliable_hex' in case:
            tag, framed_body = record(bytes.fromhex(case['reliable_hex']))
            assert tag == 9 and framed_body == body
        if 'unreliable_hex' in case:
            tag, framed_body = datagram(bytes.fromhex(case['unreliable_hex']))
            assert tag == 9 and framed_body == body
        must_reject(lambda: publication(body[:-1], c, q))
        must_reject(lambda: publication(body + b'\x00', c, q))
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
    assert Reader(bytes.fromhex('ffffffff')).index(optional=True) is None
    must_reject(lambda: Reader(bytes.fromhex('ffffffff')).index())
    must_reject(lambda: datagram(b''))
    must_reject(lambda: datagram(b'\x00'))
    must_reject(lambda: datagram(bytes.fromhex(fixture['records'][0]['hex'])[4:]))
    for case in fixture['records']:
        raw = bytes.fromhex(case['hex'])
        must_reject(lambda: record(raw[:-1]))
        must_reject(lambda: record(raw + b'\x00'))
    first = bytes.fromhex(fixture['publications'][0]['hex'])
    bad_padding = bytearray(first); bad_padding[16] |= 0x80
    must_reject(lambda: publication(bad_padding, c, fixture['requests']['inputs']))
    bad_ref = json.loads(json.dumps(c)); bad_ref['sample_descriptors'][0]['press_count_sample'] = 0
    must_reject(lambda: validate_capabilities(bad_ref))
    check_links(fixture['requirements_commit'])
    print(f"Verified {len(fixture['records'])} reliable records, {len(fixture['datagrams'])} clock datagrams, {len(fixture['publications'])} publications, {len(fixture['formats'])} scalar formats, clock arithmetic, malformed data and Markdown links.")

if __name__ == '__main__':
    main()
