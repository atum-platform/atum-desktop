import shared from '../../eslint.config.shared.mjs'

// t3/upstream/ is T3 Code's source, vendored byte for byte (scripts/sync-t3-design.mjs): never linted or reformatted.
export default [{ ignores: ['dist/**', 't3/**'] }, ...shared]
