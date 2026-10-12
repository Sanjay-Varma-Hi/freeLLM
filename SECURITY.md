# Security Policy

FreeLLMAPI holds real credentials: your provider API keys (encrypted at rest),
a unified `/v1` bearer token, and a dashboard account. Bugs that could expose
any of those are taken seriously.

## Supported versions

Only the latest commit on `main` is supported. Pull the latest code and redeploy
to stay patched.

## Reporting a vulnerability

Please report security issues privately through GitHub's
[private vulnerability reporting](https://github.com/Sanjay-Varma-Hi/freeLLM/security)
(**Security → Report a vulnerability**), or by email to
**sanjayvarmacol@gmail.com** with `[security]` in the subject.

Please don't open a public issue for a security bug until a fix is available.

A useful report includes:

- The affected commit and how you run it (Docker, Render, `npm run dev`).
- The impact — what an attacker could do (read keys, bypass auth, etc.).
- Steps to reproduce. Redact any real provider keys.
- Relevant server log lines.

## Operational advice

- Keep `ENCRYPTION_KEY` secret and never change it once data exists.
- Treat `MONGODB_URI` like a password; restrict Atlas database users to this app.
- Do not share your unified API key; regenerate it from the dashboard if it leaks.
