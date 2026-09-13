process.env.LOG_LEVEL = 'silent';

const { test, describe } = require('node:test');
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');

const CLI = path.resolve(__dirname, '..', 'src', 'cli.js');
const ROOT = path.resolve(__dirname, '..');

/** Run the CLI and capture its output, whatever the exit code. */
function runCli(args = [], env = {}) {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], {
      env: { ...process.env, ...env },
      timeout: 20000,
    }, (err, stdout, stderr) => {
      resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe('CLI help', () => {
  test('bare invocation prints short help and exits cleanly', async () => {
    const { code, stdout } = await runCli();
    assert.strictEqual(code, 0);
    assert.match(stdout, /Usage: ipv6-bridge/);
    assert.match(stdout, /ipv6-bridge --help/);
  });

  test('--help documents every command', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.strictEqual(code, 0);
    for (const command of ['start', 'doctor', 'status', '--version']) {
      assert.ok(stdout.includes(command), `--help should document "${command}"`);
    }
  });

  test('--help documents every configuration variable the code reads', async () => {
    const { stdout } = await runCli(['--help']);

    // Any env var config.js reads must be discoverable from --help, so the two
    // cannot drift apart.
    const configSource = fs.readFileSync(path.join(ROOT, 'src', 'config.js'), 'utf8');
    const referenced = new Set(
      [...configSource.matchAll(/process\.env\.([A-Z0-9_]+)/g)].map((m) => m[1])
        .concat([...configSource.matchAll(/(?:intFromEnv|boolFromEnv)\('([A-Z0-9_]+)'/g)].map((m) => m[1]))
    );

    const missing = [...referenced].filter((name) => !stdout.includes(name));
    assert.deepStrictEqual(missing, [], `--help is missing: ${missing.join(', ')}`);
  });

  test('--help shows usage examples', async () => {
    const { stdout } = await runCli(['--help']);
    assert.match(stdout, /EXAMPLES/);
    assert.match(stdout, /FORCE_BRIDGE=1/);
    assert.match(stdout, /SECURITY/);
  });

  test('-h and help are aliases', async () => {
    const long = (await runCli(['--help'])).stdout;
    assert.strictEqual((await runCli(['-h'])).stdout, long);
    assert.strictEqual((await runCli(['help'])).stdout, long);
  });
});

describe('CLI version', () => {
  test('reports the package version', async () => {
    const { version } = require('../package.json');
    for (const flag of ['--version', '-v', 'version']) {
      const { code, stdout } = await runCli([flag]);
      assert.strictEqual(code, 0);
      assert.strictEqual(stdout.trim(), version, `${flag} should print the version`);
    }
  });
});

describe('CLI errors', () => {
  test('rejects an unknown command', async () => {
    const { code, stderr } = await runCli(['frobnicate']);
    assert.strictEqual(code, 1);
    assert.match(stderr, /Unknown command/);
  });

  test('reports configuration errors without a stack trace', async () => {
    const { code, stderr } = await runCli(['start'], { NAT64_PREFIX: 'garbage' });
    assert.strictEqual(code, 1);
    assert.match(stderr, /Configuration error/);
    assert.ok(!stderr.includes('at Object.'), 'should not dump a stack trace at the user');
  });

  test('rejects an out-of-range port', async () => {
    const { code, stderr } = await runCli(['start'], { IPV6_BRIDGE_PORT: '99999' });
    assert.strictEqual(code, 1);
    assert.match(stderr, /between 1 and 65535/);
  });

  test('status explains itself when no bridge is running', async () => {
    const { code, stderr } = await runCli(['status'], { IPV6_BRIDGE_PORT: '9' });
    assert.strictEqual(code, 1);
    assert.match(stderr, /No bridge is responding/);
    assert.match(stderr, /ipv6-bridge start/);
  });
});

describe('documentation consistency', () => {
  test('every documented file exists', () => {
    for (const file of ['GUIDE.md', 'API.md', 'ARCHITECTURE.md', 'ROADMAP.md', 'CHANGELOG.md', 'CONTRIBUTING.md']) {
      assert.ok(fs.existsSync(path.join(ROOT, 'docs', file)), `docs/${file} is referenced but missing`);
    }
  });

  test('package.json files field covers everything the docs link to', () => {
    const pkg = require('../package.json');
    assert.ok(pkg.files.includes('docs/'), 'docs/ must ship so README links resolve on npm');
    assert.ok(pkg.files.includes('src/'));
  });

  test('the changelog documents the current version', () => {
    const { version } = require('../package.json');
    const changelog = fs.readFileSync(path.join(ROOT, 'docs', 'CHANGELOG.md'), 'utf8');
    assert.ok(changelog.includes(`[${version}]`), `CHANGELOG.md has no entry for ${version}`);
  });

  test('README documents the commands the CLI actually supports', () => {
    const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
    for (const command of ['doctor', 'status', 'start']) {
      assert.ok(readme.includes(`ipv6-bridge ${command}`), `README should show "ipv6-bridge ${command}"`);
    }
  });

  test('relative links in docs resolve to real files', () => {
    const files = [
      ['README.md', ROOT],
      ...['GUIDE.md', 'API.md', 'ARCHITECTURE.md', 'ROADMAP.md', 'CONTRIBUTING.md']
        .map((f) => [path.join('docs', f), ROOT]),
    ];

    const broken = [];
    for (const [relative, base] of files) {
      const full = path.join(base, relative);
      const content = fs.readFileSync(full, 'utf8');
      const dir = path.dirname(full);

      for (const match of content.matchAll(/\]\((?!https?:|#)([^)]+\.md)(?:#[^)]*)?\)/g)) {
        if (!fs.existsSync(path.resolve(dir, match[1]))) {
          broken.push(`${relative} -> ${match[1]}`);
        }
      }
    }

    assert.deepStrictEqual(broken, [], `broken links: ${broken.join(', ')}`);
  });
});
