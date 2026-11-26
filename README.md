# FastBlog EmDash Sandboxed Plugins

Public monorepo of lightweight, capability-scoped [EmDash CMS](https://emdashcms.com/) sandboxed plugins built and maintained by [FastBlog](https://fastblog.cc).

## Packages

- [`packages/countdown-gif`](./packages/countdown-gif): **FastBlog Countdown GIF & Evergreen Links (`countdown-gif`)** — Zero-permission (`No permissions`) animated GIF89a countdown timers for newsletters, Evergreen deadline redirects, and 4 built-in MCP tools.

## One-Time Setup for Delegated Automated Releases

1. Install workspace dependencies:
   ```bash
   pnpm install
   ```
2. Log in with your **clean, dedicated** Atmosphere (Bluesky / custom domain) publisher account (`isupermantw1.bsky.social`, DID `did:plc:776f7xdpfb7dj5ti2l3au3ga`):
   > ⚠️ Never publish from an active Bluesky social account whose `com.atproto.sync.getRepo` CAR export exceeds **4.5 MB** (`DEFAULT_DIRECT_PDS_MAX_RESPONSE_BYTES = 5 MB` in `@emdash-cms/registry-client`). Keep the publisher account strictly for plugin profile & release records.
   ```bash
   cd packages/countdown-gif
   pnpm exec emdash-plugin login isupermantw1.bsky.social
   pnpm exec emdash-plugin whoami
   ```
3. Register the signed package profile on your PDS:
   ```bash
   pnpm exec emdash-plugin profile setup
   ```
   Choose **When plugin permissions increase** (`escalation-only`) so routine updates publish automatically without Passkey prompts.
4. Visit `https://releases.emdashcms.com`, sign in with the same Atmosphere account, and click **Authorize publishing**.
5. Run the first release (or trigger from FastBlog Control Plane → **Sandbox 外掛中心**) and approve `All package version tags` on the first `connection-url` prompt.
