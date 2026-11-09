/**
 * Test-support scanner for the Atum branding promise: no user-visible copy value
 * names the product-internal `Hermes`/`Matrix` codenames. It walks rendered
 * values — never source text — so it survives refactors and runs against the
 * real modules: exported strings, arrays, and objects are visited recursively,
 * and function-valued entries are called with representative synthetic
 * arguments (or a caller-supplied hook runner for React hooks) before their
 * returns are visited too.
 */

export interface BrandCopyScanOptions {
  /** Desktop locales whose copy tables must all be produced and checked. */
  locales: readonly string[]
  /** The product-internal names to keep out of user-visible values. */
  productName: RegExp
  /** Whole values reviewed as legitimate technical exceptions, with the reason. */
  exceptions: ReadonlyMap<string, string>
  /** Representative argument tuples for functions the default plan cannot reach, keyed `file::export`. */
  explicitPlans: Record<string, unknown[][]>
  /** Runs a React hook outside a component and returns its current value. */
  callHook?: (path: string, hook: () => unknown, locale: string) => unknown
}

export interface BrandCopyScanner {
  /** Visit every exported value of one copy module. */
  scan(file: string, exports: Record<string, unknown>): void
  /** Collected `path: value` violations, in discovery order. */
  violations(): string[]
}

export function createBrandCopyScanner(options: BrandCopyScanOptions): BrandCopyScanner {
  const violations: string[] = []
  const visited = new WeakSet<object>()

  const eachLocale = (build: (locale: string) => unknown[][]): unknown[][] => options.locales.flatMap(build)

  /** Representative scalar arguments for functions reached inside a copy table (a plural count,
   * a name, a device). Locale-selecting top-level accessors get the full per-locale default plan. */
  function defaultArgumentPlans(arity: number): unknown[][] {
    if (arity === 0) {
      return [[]]
    }

    return eachLocale(locale => [
      [locale],
      [locale, 'Moon'],
      ['Moon', locale],
      [locale, 'Moon', 'Atum'],
      ['Moon', locale, 1],
      [locale, 'Moon', 'Atum', Date.now()]
    ]).filter(args => args.length >= arity)
  }

  function record(path: string, text: string): void {
    if (!options.productName.test(text) || options.exceptions.has(text)) {
      return
    }

    violations.push(`${path}: ${JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text)}`)
  }

  function visitFunction(path: string, fn: (...args: never[]) => unknown): void {
    const isHook = /(?:^|[.:])use[A-Z][A-Za-z]*$/u.test(path) && fn.length === 0

    if (isHook && options.callHook) {
      for (const locale of options.locales) {
        let current: unknown

        try {
          current = options.callHook(path, fn as () => unknown, locale)
        } catch {
          continue
        }

        visit(`${path}[${locale}]`, current, 0)
      }

      return
    }

    const plans = options.explicitPlans[path] ?? defaultArgumentPlans(fn.length)

    for (const args of plans) {
      let produced: unknown

      try {
        produced = fn(...(args as never[]))
      } catch {
        // A copy accessor called with synthetic arguments may reject them; only returned
        // strings are the promise this scanner checks.
        continue
      }

      visit(`${path}(${args.map(String).join(', ')})`, produced, 0)
    }
  }

  function visit(path: string, value: unknown, depth: number): void {
    if (depth > 12) {
      return
    }

    if (typeof value === 'string') {
      record(path, value)

      return
    }

    if (typeof value === 'function') {
      visitFunction(path, value as (...args: never[]) => unknown)

      return
    }

    if (!value || typeof value !== 'object' || visited.has(value)) {
      return
    }

    visited.add(value)

    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(`${path}[${index}]`, item, depth + 1))

      return
    }

    for (const [key, entry] of Object.entries(value)) {
      visit(`${path}.${key}`, entry, depth + 1)
    }
  }

  return {
    scan(file, exports) {
      for (const [key, value] of Object.entries(exports)) {
        visit(`${file}::${key}`, value, 0)
      }
    },
    violations() {
      return [...violations]
    }
  }
}
