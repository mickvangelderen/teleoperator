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


for arguments in [['--unknown'], ['--listen', 'invalid'], ['--synthetic-lifecycle'], ['--synthetic', '--device', 'unrelated'], ['--virtual-linear-speed','2'], ['--synthetic-virtual-demo'], ['--synthetic','--synthetic-virtual-demo'], ['--virtual-pose','--virtual-linear-speed','NaN'], ['--virtual-pose','--virtual-angular-speed','inf'], ['--virtual-pose','--virtual-linear-speed','0'], ['--virtual-pose','--virtual-angular-speed','721']]:
    result = subprocess.run([BINARY, *arguments], capture_output=True, timeout=5)
    assert result.returncode == 2, (arguments, result)

inventory = json.loads(subprocess.check_output([BINARY, '--list'], timeout=5))
print('Physical inventory:', json.dumps(inventory))

for arguments in [[], ['--device', 'missing-test-device'], ['--synthetic'], ['--synthetic', '--virtual-pose']]:
    synthetic = '--synthetic' in arguments
    virtual = '--virtual-pose' in arguments
    child = subprocess.Popen(
        [BINARY, '--listen', '127.0.0.1:0', '--run-for', '15', *arguments],
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
        assert health['pose'] is virtual and health['prediction'] is False
        if virtual:
            assert health['selected']['virtual_pose']['supported'] is True
            assert health['selected']['virtual_pose']['enabled'] is False
            assert health['selected']['virtual_pose']['physical_tracking'] is False
        assert request(port, '/offer', {'type': 'offer', 'sdp': ''}, 'https://example.invalid')[0] == 403
        assert request(port, '/offer', {'type': 'answer', 'sdp': ''})[0] == 400
        if synthetic:
            assert health['selected']['device']['synthetic'] is True
            assert request(port, '/offer', {'type': 'offer', 'sdp': ''})[0] == 400
        elif '--device' in arguments or not any(item['eligible'] for item in inventory):
            assert health['selected'] is None
            status, body = request(port, '/offer', {'type': 'offer', 'sdp': ''})
            assert status == 503 and health['backend']['status'] in body.decode()
            if '--device' in arguments:
                assert 'missing-test-device' in body.decode()
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
        assert f'XR_OPERATOR_URL=http://127.0.0.1:{port} pnpm dev' in errors
        print('Reaped owned process', child.pid)

print('PASS CLI/HTTP status, validation, origin and shutdown checks')
