# Model picker provider marks

These SVGs are bundled by Vite. The picker never fetches provider artwork at runtime. It renders
the files as CSS masks so monochrome marks follow the current theme; only the established brand
colours called out below are applied. The artwork identifies the provider named beside it and
does not imply endorsement. Atum's eclipse is not part of this set.

## Simple Icons

Vector paths were copied from `simple-icons/simple-icons` commit
`90646e4bf7f3b89df6c37e65baf3e7bc759a517c` on 2026-10-26. The Simple Icons project is released
under CC0-1.0; the licence text already ships at
`third-party/licenses/texts/CC0-1.0.txt`. Its disclaimer notes that CC0 does not waive the brands'
trademark rights and that individual marks can carry separate terms. The picker uses each mark
only to identify the directly related provider.

| Local file | Pinned source | Source SHA-256 | Applied colour | Individual note |
| --- | --- | --- | --- | --- |
| `claude.svg` | `icons/claude.svg` | `2d6fda79eb18ddccca35b799eeb3cece0dfabc22520ce3b10abd25668df9fa93` | `#D97757` | Claude trademark; no individual licence metadata in the pinned catalog. |
| `deepseek.svg` | `icons/deepseek.svg` | `7a55a0a7391d116eba7d32807d6838478f9209f6034612941e74fbb14934e2ef` | `#5786FE` | DeepSeek trademark; no individual licence metadata. |
| `opencode.svg` | `icons/opencode.svg` | `6f7d203200ba051cdbaa726c4de0a729cee3f1cec47953f189399d951af58c4c` | theme ink | Source catalog points to anomalyco/opencode's official mark. |
| `gemini.svg` | `icons/googlegemini.svg` | `a6228d8846040401e941a39ed17459785e8324dbb7b870ce84233c9b3e9863a0` | `#8E75B2` | Google Gemini trademark; no individual licence metadata. |
| `minimax.svg` | `icons/minimax.svg` | `ef95e28b290e5954a5c0be338925d81f13b3d06a0a32af29a4bc64583fbcc368` | `#E73562` | Simple Icons records the custom permission at simple-icons/simple-icons#13982. |
| `qwen.svg` | `icons/qwen.svg` | `36854c60b26bfa5a0cc0d4123727c0ef559efba6f129c0dfa623f3c443fe3e5b` | `#6950EF` | Qwen trademark; no individual licence metadata. |
| `github-copilot.svg` | `icons/githubcopilot.svg` | `c72c1e0018e84b3128c5a1ac43ec2be135ac6ec4eb9c0ea18ed76416d23f2af3` | theme ink | Pinned catalog records MIT; GitHub trademark guidance still applies. |

Pinned source root:
`https://github.com/simple-icons/simple-icons/tree/90646e4bf7f3b89df6c37e65baf3e7bc759a517c`.

## Lobe Icons

`openai.svg` and `grok.svg` were copied from `lobehub/lobe-icons` commit
`8b7bbc433d38437fa2b0cca58ae896917162b812` on 2026-10-26. Lobe Icons is MIT licensed,
Copyright (c) 2023 LobeHub; the standard MIT text already ships at
`third-party/licenses/texts/MIT.txt`.

| Local file | Pinned source | Source SHA-256 | Applied colour | Brand note |
| --- | --- | --- | --- | --- |
| `openai.svg` | `packages/static-svg/icons/openai.svg` | `a595df6b423920c67a7f8f73c063e4bfb72d415948097b6cac063a2366bb5186` | theme ink | OpenAI's mark remains subject to https://openai.com/brand; it is used only beside ChatGPT/OpenAI routes. |
| `grok.svg` | `packages/static-svg/icons/grok.svg` | `9175fc90c22655160231976c849f25a03b888d7cc0e04c5f1b987b659bb07c95` | theme ink | Grok/xAI trademark; used only beside xAI/Grok routes. |

Pinned source root:
`https://github.com/lobehub/lobe-icons/tree/8b7bbc433d38437fa2b0cca58ae896917162b812`.

The existing installed `@icons-pack/react-simple-icons` package supplies the other recognized
marks (Google, OpenRouter, Mistral, Ollama, Hugging Face, NVIDIA, GitHub and Meta) under its MIT
wrapper licence and the upstream Simple Icons trademark disclaimer. A provider with no recognized
family deliberately falls back to its initial.
