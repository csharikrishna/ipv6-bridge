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

We use the Node.js built-in test runner (`node --test`):

```bash
npm test
```

When adding a new feature or fixing a bug:

- Add unit tests that cover the new behavior.
- Tests should be deterministic and not depend on network connectivity.
- Use mocks for DNS and HTTP calls where possible.

## Reporting Issues

- Search existing issues before creating a new one.
- Include your Node.js version, operating system, and steps to reproduce.
- If relevant, include the output of `npx ipv6-bridge --help`.

## License

By contributing, you agree that your contributions will be licensed under the MIT License.
