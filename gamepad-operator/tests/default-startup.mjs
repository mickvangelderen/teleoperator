// Run on free default ports from a clean viewer checkout. A physical pad is required
// for the stock launch. Pass --synthetic to exercise the same defaults without hardware.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {stripVTControlCharacters} from 'node:util';

const operator = fileURLToPath(new URL('../', import.meta.url));
const viewer = fileURLToPath(new URL('../../viewer/', import.meta.url));
const {chromium} = createRequire(new URL('../../viewer/package.json', import.meta.url))('playwright-core');
const synthetic = process.argv[2] === '--synthetic';
assert.deepEqual(process.argv.slice(2), synthetic ? ['--synthetic'] : []);

const env = {...process.env};
delete env.XR_OPERATOR_URL;
const processes = [];
function launch(command, args, cwd) {
  const child = spawn(command, args, {cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
  processes.push(child);
  child.log = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', data => { child.log = (child.log + stripVTControlCharacters(data.toString())).slice(-8192); });
  }
  return child;
}
async function address(child, pattern) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
    const match = child.log.match(pattern);
    if (match) return new URL(match[1]);
    await delay(50);
  }
  throw Error('Startup failed: ' + child.log);
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise(resolve => child.once('exit', resolve));
  process.kill(-child.pid, 'SIGTERM');
  const timer = setTimeout(() => process.kill(-child.pid, 'SIGKILL'), 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

let browser;
try {
  const server = launch('cargo', synthetic ? ['run', '--', '--synthetic'] : ['run'], operator);
  const endpoint = await address(server, /Gamepad Operator \S+ (http:\/\/\S+)/);
  const ui = launch('pnpm', ['dev'], viewer);
  const url = await address(ui, /Local:\s+(http:\/\/\S+)/);
  browser = await chromium.launch({executablePath: process.env.CHROMIUM_EXECUTABLE ?? '/opt/google/chrome/chrome'});
  const page = await browser.newPage();
  await page.goto(url.href);
  const owned = [endpoint.origin, ...Array.from(server.log.matchAll(/LAN signaling: (http:\/\/\S+)/g), match => new URL(match[1]).origin)];
  await page.waitForFunction(() => !!document.querySelector('#target')?.value);
  const selected = await page.locator('#target').inputValue();
  assert.ok(owned.includes(selected), `Expected this test's operator, got ${selected}`);
  const health = await page.request.get(new URL('/api/health', url).href, {headers: {'X-Operator-Address': selected}});
  assert.equal(health.status(), 200);
  const info = await health.json();
  assert.equal(info.application, 'Gamepad Operator');
  assert.ok(info.selected?.connected, JSON.stringify(info.backend));
  assert.equal(info.selected.device.synthetic, synthetic);

  const offer = page.waitForResponse(r => r.url().endsWith('/api/offer'));
  await page.getByRole('dialog').getByRole('button', {name: 'Connect', exact: true}).click();
  const answer = await offer;
  const offered = await answer.request().headerValue('X-Operator-Address');
  assert.ok(owned.includes(offered), `Unexpected signaling target ${offered}`);
  assert.equal(answer.status(), 200, answer.ok() ? undefined : await answer.text());
  await page.locator('subscription-editor .subscription-message').filter({hasText: /\d+ packets/}).waitFor();
  assert.equal(await page.locator('#status').innerText(), 'Connected');
  const row = page.locator('tr[data-descriptor^="/user/gamepad/input/"], tr[data-descriptor^="/gamepad/raw/"]').first();
  await row.scrollIntoViewIfNeeded();
  await page.waitForFunction(el => el.dataset.available === 'true', await row.elementHandle());
  console.log(url.origin, '→', offered, info.selected.device.name, await page.locator('#sample-summary').innerText(),
    await row.getAttribute('data-descriptor'), await row.locator('.sample-value').innerText(),
    await page.locator('.subscription-message').innerText());

  await page.locator('#connect').click();
  await page.locator('subscription-editor').waitFor({state: 'detached'});
  assert.equal(await page.locator('#status').innerText(), 'Disconnected');
  assert.equal(await page.locator('#sample-summary').isVisible(), false);

  await stop(server);
  const failed = page.waitForResponse(r => r.url().endsWith('/api/offer'));
  await page.locator('#connect').click();
  const status = (await failed).status();
  assert.ok(status >= 500);
  await page.locator('#error').waitFor({state: 'visible'});
  assert.equal(await page.locator('#status').innerText(), 'Disconnected');
  assert.equal(await page.locator('#workspace-title').innerText(), 'Operator disconnected');
  assert.equal(await page.locator('#sample-summary').isVisible(), false);
  assert.equal(await page.locator('subscription-editor').count(), 0);
  console.log('PASS default startup, live input, disconnect and failed offer (HTTP ' + status + ')');
} catch (error) {
  for (const child of processes) console.error(child.log);
  throw error;
} finally {
  try { await browser?.close(); } finally {
    for (const child of processes.reverse()) await stop(child);
  }
}
