// These proprietary Anthropic skills prohibit third-party distribution. They
// are removed only from the git-archived staging tree; repository sources and
// all neighboring Hermes capabilities remain untouched.
export const RESTRICTED_PRODUCTIVITY_SKILL_SOURCE_PATHS = Object.freeze([
  'skills/productivity/docx',
  'skills/productivity/xlsx',
  'skills/productivity/pdf',
  'skills/productivity/powerpoint'
])

// The site generator embeds the complete proprietary definitions in these
// tracked pages. They are removed from the archived runtime along with the
// source skills, without broadly removing the website or other skills.
export const RESTRICTED_GENERATED_SKILL_SOURCE_PATHS = Object.freeze([
  'website/docs/user-guide/skills/bundled/productivity/productivity-docx.md',
  'website/docs/user-guide/skills/bundled/productivity/productivity-xlsx.md',
  'website/docs/user-guide/skills/bundled/productivity/productivity-pdf.md',
  'website/docs/user-guide/skills/bundled/productivity/productivity-powerpoint.md',
  'website/i18n/zh-Hans/docusaurus-plugin-content-docs/current/user-guide/skills/bundled/productivity/productivity-powerpoint.md'
])

export const RESTRICTED_RUNTIME_SOURCE_PATHS = Object.freeze([
  ...RESTRICTED_PRODUCTIVITY_SKILL_SOURCE_PATHS,
  ...RESTRICTED_GENERATED_SKILL_SOURCE_PATHS
])

// SHA-256 fingerprints are of the complete protected skill bodies, generated
// copies, and shared proprietary license text. They permit a bounded audit for
// relocated copies without copying licensed text into release tooling.
export const RESTRICTED_RUNTIME_CONTENT_FINGERPRINTS = Object.freeze([
  { id: 'productivity-docx', kind: 'canonical_skill_body', sha256: 'cf17a6245da720b7cc3c61b77cc144225a32547568c4665fb77f0b0da96ff40a' },
  { id: 'productivity-xlsx', kind: 'canonical_skill_body', sha256: '5fb6612978efcf12596edbaa4e23a080d8aba97fcae058c2510c28d65fe1d12b' },
  { id: 'productivity-pdf', kind: 'canonical_skill_body', sha256: '7f5e2db4342a69cc8193803f855fce8739c6b8f4d051a3d2691f827f595ce23e' },
  { id: 'productivity-powerpoint', kind: 'canonical_skill_body', sha256: 'a81d5c61b844b21b07393cd4bef7db0de6d4d484cecd40b00621087bc442263e' },
  { id: 'productivity-docx', kind: 'generated_skill_copy', sha256: 'c4af9c8acf4ea3d8ed62241d89d0e35697b6f47205ce21f651bb2020c54301a8' },
  { id: 'productivity-xlsx', kind: 'generated_skill_copy', sha256: 'fd2d52d8e4d0fb40645bcd14e781bb91b488b920f97a8169c0312bddd2786ae2' },
  { id: 'productivity-pdf', kind: 'generated_skill_copy', sha256: '5be909ae267d3df174a42c101bcc22c41aa4f864495f0d06dbe570e9f1f6a227' },
  { id: 'productivity-powerpoint', kind: 'generated_skill_copy', sha256: 'fb82737138fdbacd4844d2e6f8db4523c1bc4fbc25bb9eb8e1e221eb486e98bc' },
  { id: 'productivity-powerpoint', kind: 'generated_skill_copy', sha256: '02352bb0f47277da0578c610fe139d8753bb5921e2d713bdf58e41e46ce4259a' },
  { id: 'productivity-skills', kind: 'canonical_license_text', sha256: '79f6d8f5b427252fa3b1c11ecdbdb6bf610b944f7530b4de78f770f38741cfaa' }
])
