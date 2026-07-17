# Changelog

## [0.19.1](https://github.com/SunrisesIllNeverSee/sigrank-mcp/compare/v0.19.0...v0.19.1) (2026-07-17)


### Bug Fixes

* revert to 3-digit versioning (0.0.178) + enforce in CI ([40aa9a6](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/40aa9a6d1c51ca299974e6fdfc4b36f24369635f))

## [0.19.0](https://github.com/SunrisesIllNeverSee/sigrank-mcp/compare/v0.18.1...v0.19.0) (2026-07-14)


### Features

* add 'other' platform adapter for user-supplied token data ([0e6af8e](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/0e6af8e36620df88c13822e292499b003442f645))
* auto-detect platforms via tokscale instead of brute-force all adapters ([e72d2d9](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/e72d2d9f5615832cd58eaeff7e17ab961dc6fa49))
* complete tokscale client map (40 clients) + model breakdown tool ([657b87a](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/657b87a690576ad81396e219c61447198ada67d8))
* platform sync automation script + weekly CI check ([29096aa](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/29096aad1b2f3c0bce6dad15d8c4fa59871793e4))


### Bug Fixes

* unescaped backticks in index.mjs template literal + add devin/opencode to CLI platform list ([24cfdfe](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/24cfdfe956f4776fe8d88f2108a6dd644f7269d8))

## [0.18.1](https://github.com/SunrisesIllNeverSee/sigrank-mcp/compare/v0.18.0...v0.18.1) (2026-07-14)


### Bug Fixes

* **test:** ALL_PLATFORMS count 15→16 + accept records() for devin adapter ([8d7f0f5](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/8d7f0f56cea3686e046a407732233f9bbd7d4916))

## [0.18.0](https://github.com/SunrisesIllNeverSee/sigrank-mcp/compare/v0.17.2...v0.18.0) (2026-07-14)


### Features

* Lane 3 — intent schema files + competitive layer + eval benchmark ([42b9607](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/42b9607ba4cec8aa5f169b1caf74aa05017c4856))
* multi-platform support in tokenpull + tokenpull_submit ([c2d1458](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/c2d1458d1f899034e9826d2100b8ec60b421ddd4))


### Bug Fixes

* align manifest.json version to 0.17.2 (matches package.json + server.json) ([30c3a37](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/30c3a372b3ac212bc99fd64535687cf6789922f2))
* auto-clear code buffer on sign-in failure (0.17.5) ([72caa9a](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/72caa9a246c85e38663989981cd233ae98c3b03f))
* curl fallback for Vercel bot protection 403 (0.0.177) ([abc8610](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/abc861041a3db14497383caecb39550667ec3b93))
* Devin adapter reads from sessions.db (real per-message telemetry) ([a5aaaf2](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/a5aaaf275516e793aec0e58c13c09d985e68d05c))
* Devin tokens now readable via tokenpull (tokscale fallback) ([abfb1eb](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/abfb1eb93fd92f669d742ce8b383dffc35ef094f))
* Esc/arrow-key race condition in TUI (0.17.4) ([555e6bd](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/555e6bd3dd5e45963eff2ff95d85b02955d40e2b))
* resolve CodeQL url-substring-sanitization alert (0.0.176) ([babf863](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/babf86379a2d97869738a1c8b01269c1d8c149bf))
* route Devin through Codex-style ioRatio split ([08d4441](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/08d4441437ce38bdfacc8936d1771d654999ac28))
* unblock sign-in deadlock + keystore resilience (0.17.3) ([569fc94](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/569fc948cd0f74fdf930113074c562724927ffe8))

## [0.17.0](https://github.com/SunrisesIllNeverSee/sigrank-mcp/compare/v0.16.1...v0.17.0) (2026-07-10)


### Features

* add 4 MCP resources (scoring formula, class tiers, install guide, privacy model) ([1227828](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/1227828159c299bd1a5e0ebf3bb47aece3d3583d))


### Bug Fixes

* add .mcpbignore + fix manifest.json repository object for MCPB bundle ([eb1046f](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/eb1046f6e291db8681e01aa06593091a9b94447d))
* add title annotations to all 15 MCP tools (Anthropic directory requirement E) ([36e7d5d](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/36e7d5d793fe25d4dd9d780422309594a4118311))
* bump manifest.json to 0.16.1 + update description ([abd19b0](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/abd19b0a6a713389c1f0b4eb6b17ccc41c9825bd))
* Smithery bundle + metadata fixes ([d2a3a10](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/d2a3a10d5106c506ea2a57ac3f6ccc36ee9a55f6))
* update server.json — add registryBaseUrl, _meta, better description ([a929a6e](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/a929a6e4052b9edb9d549434f803a85f5d4fc572))

## [0.16.1](https://github.com/SunrisesIllNeverSee/sigrank-mcp/compare/v0.16.0...v0.16.1) (2026-07-09)


### Bug Fixes

* remove readOnlyHint from watch_tokenpull ([c867eed](https://github.com/SunrisesIllNeverSee/sigrank-mcp/commit/c867eedc9de1f4f37e0a9db08bc41aa0d426be33))
