# Security Policy

## Reporting a vulnerability

Please **do not** report security problems in public issues or pull requests.

Use GitHub's private vulnerability reporting: open the repository's **Security** tab and choose **Report a vulnerability**. Include the affected version or commit, steps to reproduce, and the impact you expect. We aim to acknowledge reports within a week and will credit you in the fix unless you prefer otherwise.

## Supported versions

TeXdraft has no stable releases yet. Security fixes land on `main`; please reproduce on the latest commit before reporting.

## Scope and known limitations

Particularly interesting areas:

- **Compile isolation** — a LaTeX document reading files outside its project, reaching the server's environment, or executing code (see the [security model](docs/self-hosting.md#security-model)). Note that `COMPILE_SANDBOX=auto` intentionally falls back to no isolation, with a startup warning, when neither bubblewrap nor the unprivileged-user mode is available; that fallback is documented behaviour, not a vulnerability.
- **Authorization** — accessing or modifying projects without the required role, through the REST API, the collaboration WebSocket, MCP or OAuth.
- **OAuth / MCP** — token leakage, redirect or PKCE bypasses, server-side request forgery through client metadata documents or `upload_file`.
- **Accounts** — bypassing registration modes, invites, account disabling or rate limits.

Out of scope: denial of service through very large or slow-to-compile documents (compiles have time limits), and vulnerabilities in third-party AI providers.

## Deployment checklist

- Set a long random `SESSION_SECRET` and serve TeXdraft over HTTPS.
- Use `COMPILE_SANDBOX=bwrap` (or the Docker image, or `COMPILE_RUNNER=docker`) whenever anyone other than you can sign in.
- Choose `REGISTRATION=invite` or `closed` for private instances.
- Keep `ALLOW_LOCAL_AGENT_SETUP=false` unless the server is used by a single person.
