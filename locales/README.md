# Locales

This directory holds the bundled message catalogs. `en.yaml` is the source of
truth for core keys; each `<lang>.yaml` is a core catalog and each
`<lang>.tui.yaml` is a TUI catalog whose keys follow `_keys.tui.json`. Missing
keys fall back to English.

## Vietnamese (`vi`)

Set `display.language` to `vi` with `hermes config set display.language vi`.
`vi-VN`, `vi_VN`, `Vietnamese`, `Tiếng Việt`, and `Tieng Viet` resolve to the same
catalog. The native language picker lists **Tiếng Việt** with left-to-right text.
The core and TUI catalogs use the existing Hermes loader, including its overlay,
plugin-pack, and English fallback precedence. Desktop-specific translations are
separate from these catalogs.

### Attribution and adaptation

Upstream Hermes main did not bundle Vietnamese when checked. Pending
[Hermes PR #78626](https://github.com/NousResearch/hermes-agent/pull/78626)
provides an older core catalog; its coverage predates the current English keys.
The fuller existing native language pack submitted in
[Hermes PR #130281](https://github.com/NousResearch/hermes-agent/pull/130281)
was adopted instead:

- Source: [moken627-hub/hermes-lang-vi](https://github.com/moken627-hub/hermes-lang-vi/tree/79bbcf3646b54976af72ea2e2c46b8af9d9d209f),
  revision `79bbcf3646b54976af72ea2e2c46b8af9d9d209f`.
- Vietnamese translation copyright 2026 5ac; inherited Hermes strings copyright
  2025 Nous Research. The full MIT notices are preserved in
  [LICENSES/hermes-lang-vi-MIT.txt](../LICENSES/hermes-lang-vi-MIT.txt).
- Removed keys absent from this fork's English catalogs, translated missing core
  and TUI keys, and updated messages whose English meaning changed since the pack.
  Parser-sensitive menu choices, format fields, commands, and identifiers remain
  unchanged. No plugin installation or alternate translation runtime is needed.

### Voice and terms

- The agent speaks as **mình** and calls the user **bạn**. Keep **tôi** only where
  the user is the speaker (sample prompts, "Tôi đã thêm rồi" buttons).
- Prose terms: session → **phiên**, model → **mô hình**, host → **máy chủ**.
  Never translate slash commands (`/model`, `/new`), CLI subcommands
  (`hermes sessions list`), config keys, product names or code.
- Approval nouns are lowercase (`lệnh`, `đoạn mã`, `thao tác`) and never start a
  sentence. Typed approval words append Vietnamese to the English list
  (`approval.inputs.*`); replies match a whole message, so each word must belong
  to exactly one choice.

### Maintenance and verification

Core keys must match `en.yaml`, including format placeholders. TUI keys must match
`_keys.tui.json`; positional placeholders follow English function argument order.
The Python bundled-language identity table and shared TypeScript endonyms agree.

```sh
bash scripts/run_tests.sh tests/agent/test_i18n.py tests/agent/test_i18n_languages.py tests/agent/test_i18n_layers.py tests/agent/test_i18n_tui_packs.py -j 3
```

These checks exercise key and placeholder parity, language metadata, layered
resolution, and the real config setter through the Vietnamese catalog against
a temporary Hermes home.
