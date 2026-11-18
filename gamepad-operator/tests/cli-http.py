#!/usr/bin/env python3
"""Bounded CLI/HTTP checks; own and reap the exact child process."""
import json
import pathlib
import re
import selectors
import subprocess
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
BINARY = ROOT / 'target/debug/gamepad-operator'


def request(port, path, payload=None, origin=None):
    headers = {'Content-Type': 'application/json'}
    if origin:
        headers['Origin'] = origin
    req = urllib.request.Request(
        f'http://127.0.0.1:{port}{path}',
        data=None if payload is None else json.dumps(payload).encode(),
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.read()


for arguments in [['--unknown'], ['--listen', 'invalid'], ['--synthetic-lifecycle'], ['--synthetic', '--device', 'unrelated']]:
    result = subprocess.run([BINARY, *arguments], capture_output=True, timeout=5)
    assert result.returncode == 2, (arguments, result)

inventory = json.loads(subprocess.check_output([BINARY, '--list'], timeout=5))
print('Physical inventory:', json.dumps(inventory))

for synthetic in [False, True]:
    child = subprocess.Popen(
        [BINARY, '--listen', '127.0.0.1:0', '--run-for', '15', *(['--synthetic'] if synthetic else [])],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
    )
    try:
        selector = selectors.DefaultSelector()
        selector.register(child.stdout, selectors.EVENT_READ)
        assert selector.select(5), 'Child did not announce its owned listener'
        line = child.stdout.readline()
        selector.close()
        port = int(re.search(r'http://127\.0\.0\.1:(\d+)', line)[1])
        deadline = time.monotonic() + 3
        while True:
            status, data = request(port, '/health')
            assert status == 200
            health = json.loads(data)
            if health['backend'] is not None:
                break
            assert time.monotonic() < deadline
            time.sleep(.025)
        assert health['pose'] is False and health['prediction'] is False
        assert request(port, '/offer', {'type': 'offer', 'sdp': ''}, 'https://example.invalid')[0] == 403
        assert request(port, '/offer', {'type': 'answer', 'sdp': ''})[0] == 400
        if synthetic:
            assert health['selected']['device']['synthetic'] is True
            assert request(port, '/offer', {'type': 'offer', 'sdp': ''})[0] == 400
        elif not any(item['eligible'] for item in inventory):
            assert health['selected'] is None
            assert request(port, '/offer', {'type': 'offer', 'sdp': ''})[0] == 503
        print('HTTP status:', json.dumps(health))
    finally:
        child.terminate()
        try:
            _, errors = child.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            child.kill()
            child.communicate()
            raise AssertionError('Owned server failed clean shutdown')
        assert child.returncode == 0, errors
        print('Reaped owned process', child.pid)

print('PASS CLI/HTTP status, validation, origin and shutdown checks')
