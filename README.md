# FastBlog EmDash Sandboxed Plugins

Public monorepo of lightweight, capability-scoped [EmDash CMS](https://emdashcms.com/) sandboxed plugins built and maintained by [@plugins.fastblog.cc](https://fastblog.cc).

## Packages

- [`packages/countdown-gif`](./packages/countdown-gif): **Countdown GIF & Evergreen Timer (`countdown-gif`)** — Zero-permission (`capabilities: []`) animated GIF89a countdown timers for emails, Evergreen deadline 302 redirects, 6-language Block Kit dashboard + 4-in-1 Guided Onboarding, and 4 built-in MCP tools.
- [`packages/fastblog-i18n-byok`](./packages/fastblog-i18n-byok): **AI Multilingual Translator — OpenAI BYOK (`fastblog-i18n-byok`)** — Minimal-permission (`allowedHosts: ["api.openai.com"]`) AI translator using OpenAI (`gpt-6-luna` / `gpt-4o-mini`) with PortableText AST preservation, `/translate` 4-tab Workbench, Editor Sidebar Panel, Glossary, Taxonomy translation, 6-language UI + Guided Onboarding, and 6 native MCP tools.

## Publisher Identity & Domain Handle

- **Permanent Publisher DID**: `did:plc:776f7xdpfb7dj5ti2l3au3ga`
- **Custom Domain Handle**: `@plugins.fastblog.cc` (`_atproto.plugins.fastblog.cc` TXT record)

## Development & Delegated Releases

1. Install workspace dependencies:
   ```bash
   pnpm install
   ```
2. Build, typecheck, validate, test, and bundle all plugins:
   ```bash
   pnpm run typecheck && pnpm run validate && pnpm run test && pnpm run bundle
   ```
3. Push semantic version tags (`countdown-gif@0.3.0`, `fastblog-i18n-byok@0.1.0`) to trigger automated OIDC + Sigstore Delegated Releases via `.github/workflows/emdash-release.yml`.
