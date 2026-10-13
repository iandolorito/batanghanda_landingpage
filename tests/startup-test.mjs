import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

// This executes the real startup shell script, but stubs Apache and permissions.
// It verifies shell control flow, port rewriting, and failure handling; it does
// not build the Docker image or verify real Apache module loading.
const bash = process.env.BH_TEST_BASH
  ?? (process.platform === 'win32' ? 'C:/Program Files/Git/bin/bash.exe' : 'bash');
const startup = fileURLToPath(new URL('../docker/start.sh', import.meta.url));
const stub = `#!/usr/bin/env bash
set -eu
name="\${0##*/}"
{ printf '%s' "$name"; printf '\\t%s' "$@"; printf '\\n'; } >> "$HARNESS_ROOT/calls.log"
case "$name" in
  sed)
    [ "$1" = -i ]
    case "$3" in
      /etc/apache2/ports.conf) target="$HARNESS_ROOT/ports.conf" ;;
      /etc/apache2/sites-available/000-default.conf) target="$HARNESS_ROOT/site.conf" ;;
      *) echo 'Unexpected config target' >&2; exit 97 ;;
    esac
    exec /usr/bin/sed "$1" "$2" "$target"
    ;;
  apache2ctl)
    if [ "\${HARNESS_CONFIG_ERROR:-0}" = 1 ]; then
      echo 'Simulated Apache configuration error' >&2
      exit 1
    fi
    echo 'Syntax OK (stub)' >&2
    ;;
  a2dismod)
    if [ "\${HARNESS_MODULE_ERROR:-0}" = 1 ]; then exit 1; fi
    ;;
  mkdir|chown|chmod|a2enmod|apache2-foreground) ;;
  *) echo 'Unexpected harness command' >&2; exit 97 ;;
esac
`;
const runner = `#!/usr/bin/env bash
set -eu
if command -v cygpath >/dev/null 2>&1; then
  HARNESS_ROOT="$(cygpath -u "$HARNESS_ROOT")"
  STARTUP_SCRIPT="$(cygpath -u "$STARTUP_SCRIPT")"
fi
export HARNESS_ROOT
/usr/bin/chmod +x "$HARNESS_ROOT"/bin/*
export PATH="$HARNESS_ROOT/bin:/usr/bin:/bin"
exec /bin/bash "$STARTUP_SCRIPT"
`;

async function runStartup(port, overrides = {}) {
  const tempParent = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(tempParent, 'batanghanda-startup-'));
  try {
    const bin = path.join(root, 'bin');
    await mkdir(bin);
    await Promise.all([
      writeFile(path.join(root, 'ports.conf'), 'Listen 80\n'),
      writeFile(path.join(root, 'site.conf'), '<VirtualHost *:80>\n</VirtualHost>\n'),
      writeFile(path.join(root, 'runner.sh'), runner),
      ...['mkdir', 'chown', 'chmod', 'sed', 'a2dismod', 'a2enmod', 'apache2ctl', 'apache2-foreground']
        .map((command) => writeFile(path.join(bin, command), stub, { mode: 0o755 })),
    ]);
    const env = {
      ...process.env, HARNESS_ROOT: root, STARTUP_SCRIPT: startup,
      HARNESS_CONFIG_ERROR: '0', HARNESS_MODULE_ERROR: '0', ...overrides,
    };
    delete env.PORT;
    if (port !== undefined) env.PORT = port;
    const result = spawnSync(bash, ['--noprofile', '--norc', path.join(root, 'runner.sh')], {
      env, encoding: 'utf8', timeout: 10000,
    });
    assert.ifError(result.error);
    const [ports, site, calls] = await Promise.all([
      readFile(path.join(root, 'ports.conf'), 'utf8'),
      readFile(path.join(root, 'site.conf'), 'utf8'),
      readFile(path.join(root, 'calls.log'), 'utf8').catch((error) => {
        if (error.code === 'ENOENT') return '';
        throw error;
      }),
    ]);
    return { ...result, ports, site, calls: calls.trim().split('\n').filter(Boolean) };
  } finally {
    // Only delete this test's explicitly created temporary directory.
    assert.equal(path.dirname(path.resolve(root)), tempParent);
    assert.ok(path.basename(root).startsWith('batanghanda-startup-'));
    await rm(root, { recursive: true, force: true });
  }
}

test('startup uses Linux line endings and valid shell syntax', async () => {
  assert.doesNotMatch(await readFile(startup, 'utf8'), /\r/, 'The Linux startup script must use LF line endings');
  const result = spawnSync(bash, ['-n', startup], { encoding: 'utf8', timeout: 10000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
});

test('startup uses PORT and checks prefork configuration before foreground launch', async () => {
  const result = await runStartup('9876');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.ports, 'Listen 9876\n');
  assert.equal(result.site, '<VirtualHost *:9876>\n</VirtualHost>\n');
  assert.deepEqual(result.calls.slice(0, 3), [
    'mkdir\t-p\t/data', 'chown\twww-data:www-data\t/data', 'chmod\t750\t/data',
  ]);
  assert.deepEqual(result.calls.slice(-4), [
    'a2dismod\tmpm_event\tmpm_worker',
    'a2enmod\tmpm_prefork',
    'apache2ctl\t-t',
    'apache2-foreground',
  ]);
  assert.match(result.stdout, /starting Apache on port 9876 with mpm_prefork/);
});

test('startup defaults to port 8080 when PORT is absent', async () => {
  const result = await runStartup(undefined);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.ports, 'Listen 8080\n');
  assert.match(result.site, /VirtualHost \*:8080/);
});

test('invalid ports fail before filesystem preparation or Apache launch', async (t) => {
  for (const port of ['abc', '-1', '0', '65536', '80.5', ' 8080', '8080;echo injected']) {
    await t.test(JSON.stringify(port), async () => {
      const result = await runStartup(port);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /PORT must be/);
      assert.deepEqual(result.calls, []);
      assert.equal(result.ports, 'Listen 80\n');
      assert.equal(result.site, '<VirtualHost *:80>\n</VirtualHost>\n');
    });
  }
});

test('configuration failure prevents the startup diagnostic and foreground launch', async () => {
  const result = await runStartup('8080', { HARNESS_CONFIG_ERROR: '1' });
  assert.equal(result.status, 1);
  assert.equal(result.calls.at(-1), 'apache2ctl\t-t');
  assert.ok(result.calls.includes('a2dismod\tmpm_event\tmpm_worker'));
  assert.ok(result.calls.includes('a2enmod\tmpm_prefork'));
  assert.ok(!result.calls.includes('apache2-foreground'));
  assert.doesNotMatch(result.stdout, /starting Apache/);
  assert.match(result.stderr, /Simulated Apache configuration error/);
});

test('module normalization failure stops before Apache configuration and launch', async () => {
  const result = await runStartup('8080', { HARNESS_MODULE_ERROR: '1' });
  assert.equal(result.status, 1);
  assert.equal(result.calls.at(-1), 'a2dismod\tmpm_event\tmpm_worker');
  assert.ok(!result.calls.includes('a2enmod\tmpm_prefork'));
  assert.ok(!result.calls.includes('apache2ctl\t-t'));
  assert.ok(!result.calls.includes('apache2-foreground'));
});
