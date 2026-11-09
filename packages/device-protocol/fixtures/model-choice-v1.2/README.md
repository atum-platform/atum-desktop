# `atum.model-choice/1.2`: LU-R1 managed-model policy revision

- **Base:** `atum.model-choice/1.1`, pinned `e43a2ff807eba0b5d60fe2a5718b94f5234189c211915275126b01f37569036e`.
- **Wire:** unchanged `atum.model-choice/1.1`; this is the immutable policy/fixture revision.
- **Policy:** `2026-10-17.1`, digest `489e82bcce6008fd0cae824623b3e323bf7a8820a18e34bf8bab815f7999d7a0`.
- **Status:** contract-first only. No gateway route, migration, dispatch alias, Shell flag or production value changes here.

## Line-up

| Alias | Display | Provider | Input / output | Effort | Worst hold |
| --- | --- | --- | ---: | --- | ---: |
| `nguyet-thuc` | Nguyệt Thực 1.3 | `openai/gpt-6-luna` | 1,000,000 / 16,384 | medium | 10,317,213,000 micro-Protons |
| `nhat-thuc` | Nhật Thực 1.1 | `openai/gpt-6.1-sol` | 120,000 / 16,384 | medium | 19,626,624,000 micro-Protons |

`default` remains the internal unsaved alias for Nguyệt Thực. Thái Cực has no server alias or catalogue row and stays a disabled client-only row. The other curated aliases leave this policy; their gateway routes are not changed by this pack. When the policy is activated, an existing saved choice for a retired alias is atomically rewritten to the server recommendation at a higher revision and accompanied by a visible policy-change notice. It is never returned as an invalid snapshot or silently kept on its old provider route.

The public OpenRouter models response was captured once on 2026-10-18 and hashed as `572b1c16944f5296346e9da58d4c82b0743e8768714d61eaeb6e7238edbcc08d`. The selected evidence records the canonical slugs, 1,050,000 / 128,000 provider bounds, file/image/text input, tools, and supported effort vocabularies. Luna keeps its conservative above-272k price pin. Sol uses 2.00 / 10.00 below 272,000 prompt tokens; the 120,000 grant cap cannot reach the higher tier. Its 19,626.624-Proton maximum hold uses 98.13% of the unchanged 20,000-Proton turn ceiling, so any later price or budget change must re-derive the hold rather than copy it.

Every existing 1.1 route, server-derived identity rule, replay/CAS fence, secret prohibition and provider profile remains. LA4 implements and deploys the gateway/policy migration later, with the owner's explicit production go.
