/**
 * A model's readable name. The catalog's own display name wins; an identifier-only entry is
 * still shown as words ("gpt-5.6-luna" → "GPT-5.6 Luna") instead of a raw id. The table keeps
 * the brands whose spelling is not title case.
 */
const MODEL_WORDS: Readonly<Record<string, string>> = {
  claude: 'Claude',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  glm: 'GLM',
  gpt: 'GPT',
  grok: 'Grok',
  kimi: 'Kimi',
  llama: 'Llama',
  minimax: 'MiniMax',
  qwen: 'Qwen'
}

/** Brands written with their version after a hyphen, as the products do ("GPT-5.6"). */
const VERSION_HYPHEN = new Set(['GPT'])

function modelWord(word: string): string {
  const known = MODEL_WORDS[word.toLocaleLowerCase()]

  if (known) {
    return known
  }

  return word.length ? word[0].toUpperCase() + word.slice(1) : word
}

export function matrixModelDisplayName(model: string, displayName?: string): string {
  const named = displayName?.trim()

  // A catalog that repeats the id has no display name of its own; derive one instead.
  if (named && named !== model.trim()) {
    return named
  }

  const words = model
    .trim()
    .split(/[-_/\s]+/u)
    .filter(Boolean)
    .map(modelWord)

  const joined = words.reduce<string[]>((parts, word) => {
    const previous = parts.at(-1)

    if (previous && VERSION_HYPHEN.has(previous) && /^\d/u.test(word)) {
      parts[parts.length - 1] = `${previous}-${word}`
    } else {
      parts.push(word)
    }

    return parts
  }, [])

  return joined.join(' ') || model
}
