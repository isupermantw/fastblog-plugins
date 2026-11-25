# FastBlog EmDash Sandboxed Plugins

Public monorepo of lightweight, capability-scoped [EmDash CMS](https://emdashcms.com/) sandboxed plugins built and maintained by [FastBlog](https://fastblog.cc).

## Packages

- [`packages/countdown-gif`](./packages/countdown-gif): **FastBlog Countdown GIF & Evergreen Links (`countdown-gif`)** — Zero-permission (`No permissions`) animated GIF89a countdown timers for newsletters, Evergreen deadline redirects, and 4 built-in MCP tools.

## One-Time Setup for Delegated Automated Releases

1. Install workspace dependencies:
   ```bash
   pnpm install
   ```
2. Log in with your Atmosphere (Bluesky / custom domain) publisher account:
   ```bash
   cd packages/countdown-gif
   pnpm exec emdash-plugin login fastblog.cc
   pnpm exec emdash-plugin whoami
   ```
3. Register the signed package profile on your PDS:
   ```bash
   pnpm exec emdash-plugin profile setup
   ```
   Choose **When plugin permissions increase** (`escalation-only`) so routine updates publish automatically without Passkey prompts.
4. Visit `https://releases.emdashcms.com`, sign in with the same Atmosphere account, and click **Authorize publishing**.
5. Run the first release (or trigger from FastBlog Control Plane → **Sandbox 外掛中心**) and approve `All package version tags` on the first `connection-url` prompt.
