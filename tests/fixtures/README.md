# Test fixtures

## `localhost-cert.pem` / `localhost-key.pem`

A self-signed certificate and key used **only** by `tests/agent.test.js`, so TLS
behaviour can be verified against a local server without network access.

- Subject: `CN=localhost`, SANs `localhost`, `127.0.0.1`, `::1`
- Valid until 2126 (so the suite does not start failing on an expiry date)
- Generated for this repository and committed deliberately

**This key is not a secret.** It is trusted by nothing, signs nothing anyone
relies on, and grants no access. It exists so the tests can confirm two things:

1. a bridged TLS connection validates correctly against a trusted certificate
2. certificate identity is checked against the requested hostname rather than
   the synthesized address the connection travelled over

Never use it outside this test suite, and never use this pattern for a
certificate that protects anything real.

To regenerate:

```bash
openssl req -x509 -newkey rsa:2048 \
  -keyout localhost-key.pem -out localhost-cert.pem \
  -days 36500 -nodes -subj "/CN=localhost" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"
```
