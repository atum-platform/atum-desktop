import snapshot from './drive-exclusions.json'

export interface MatrixDriveImportPattern {
  expression: string
  directoryOnly: boolean
  reason: 'private' | 'code' | 'excluded'
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** The pinned engine's convertToRegexpSyntax, with wildcardsMatchSlash=false. */
export function driveExclusionExpression(glob: string): string {
  let result = ''

  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]

    if (char === '*') {
      result += '[^/]*'
    } else if (char === '?') {
      result += '[^/]'
    } else if (char === '[') {
      let end = i + 1

      for (; end < glob.length; end++) {
        if (glob[end] === ']') {
          break
        }

        if (glob[end] === '\\' && glob[end + 1] === ']') {
          end++
        }
      }

      if (end === glob.length) {
        result += '\\['
      } else {
        result += glob.slice(i, end + 1).replace(/^\[!/u, '[^')
        i = end
      }
    } else if (char === '\\' && i + 1 < glob.length) {
      const next = glob[++i]
      result += '*?[\\'.includes(next) ? escaped(next) : escaped('\\' + next)
    } else {
      result += escaped(char)
    }
  }

  return result
}

/** No hand-written exclusion list. The complete snapshot is replaced as a unit by engine facts. */
export function matrixDriveImportPatterns(patterns: readonly string[] = snapshot.patterns): MatrixDriveImportPattern[] {
  return patterns.map(raw => {
    const pattern = raw.startsWith(']') ? raw.slice(1) : raw
    const directoryOnly = pattern.endsWith('/')
    const glob = directoryOnly ? pattern.slice(0, -1) : pattern
    const expression = `${glob.includes('/') ? '^' : '(?:^|/)'}(?:${driveExclusionExpression(glob)})(?:$|/)`

    // Validate once before accepting any source; malformed future facts cannot weaken protection.
    new RegExp(expression, 'u')

    return {
      expression,
      directoryOnly,
      reason: directoryOnly
        ? 'code'
        : snapshot.atumPatterns.includes(raw) && !/^\.(?:atum-drive-|_?sync_|OpenCloudSync)/u.test(raw)
          ? 'private'
          : 'excluded'
    }
  })
}

/** The import/engine rules, including an excluded ancestor. A directory-only rule must not
 * accidentally label a regular file with that name. */
let localOnlySignature = ''
let localOnlyRules: { matcher: RegExp; directoryOnly: boolean }[] = []

export function matrixDriveLocalOnly(relative: string, directory: boolean, patterns?: readonly string[]): boolean {
  const signature = JSON.stringify(patterns ?? snapshot.patterns)

  if (localOnlySignature !== signature) {
    localOnlyRules = matrixDriveImportPatterns(patterns).map(rule => ({
      matcher: new RegExp(rule.expression, 'iu'),
      directoryOnly: rule.directoryOnly
    }))
    localOnlySignature = signature
  }

  const parts = relative.split('/')

  return localOnlyRules.some(rule =>
    parts.some((_, index) => {
      const isDirectory = index < parts.length - 1 || directory

      return (!rule.directoryOnly || isDirectory) && rule.matcher.test(parts.slice(0, index + 1).join('/'))
    })
  )
}
