# Contributing

Thank you for your interest in contributing to IPv6 Bridge!

## Getting Started

1. Fork and clone the repository.
2. Install dependencies: `npm install`
3. Run the tests: `npm test`

## Development Workflow

1. Create a feature branch from `main`.
2. Make your changes with clear, focused commits.
3. Add or update tests for any new functionality.
4. Ensure all tests pass: `npm test`
5. Submit a pull request with a clear description of the change.

## Code Style

- **Indentation**: 2 spaces.
- **Semicolons**: Required.
- **Quotes**: Single quotes for strings.
- **Module system**: CommonJS (`require`/`module.exports`).
- **No external dependencies**: The core library must remain dependency-free. Development dependencies (linting, testing) are fine.

## Project Structure

```
src/           Core library (zero dependencies)
tests/         Test suite (Node.js built-in test runner)
demo-app/      Interactive demo application
test-server/   Dual-stack test server for manual testing
examples/      Usage examples
docs/          Extended documentation
```

## Testing

We use the Node.js built-in test runner:

```bash
npm test
```

When adding a new feature or fixing a bug:

- Add tests that cover the new behavior.
- Tests must be deterministic and must not depend on network connectivity.
  Spin up a local server on an ephemeral port instead — `tests/helpers.js` has
  helpers for HTTP and TCP servers, raw requests and module reloading.
- Prefer a test that exercises the real path end to end over one that asserts a
  function exists. The proxy shipped a release where every plain-HTTP request
  returned `500` while the entire suite passed, because no test ever sent one.
- Configuration is captured when a module loads, so a test that changes
  environment variables must call `reloadModules()` before requiring anything.

### Verifying protocol behavior

The proxy is easiest to verify with a real client:

```bash
FORCE_BRIDGE=1 node src/cli.js start &
curl -x http://127.0.0.1:8080 http://example.com/     # plain HTTP
curl -x http://127.0.0.1:8080 https://example.com/    # CONNECT tunnel
curl --socks5-hostname 127.0.0.1:1080 https://example.com/
curl http://127.0.0.1:8080/status
```

Note that proxy clients send *absolute-form* request targets, which is different
from how a normal HTTP server is addressed. Reading the code is not enough to
confirm proxy behavior — drive it with a client.

## Standards

Changes to address handling should cite the relevant RFC and, where the RFC
provides test vectors, use them. `tests/ipv6.test.js` checks the RFC 6052
section 2.4 vectors directly.

## Reporting Issues

- Search existing issues before creating a new one.
- Include your Node.js version, operating system, and steps to reproduce.
- If relevant, include the output of `npx ipv6-bridge --help`.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
