import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { ProviderMark } from './model-picker-provider-mark'

afterEach(cleanup)

describe('model picker provider marks', () => {
  it.each([
    ['openai-codex', 'ChatGPT', 'openai'],
    ['openai-api', 'OpenAI', 'openai'],
    ['anthropic', 'Claude', 'claude'],
    ['deepseek', 'DeepSeek', 'deepseek'],
    ['opencode-go', 'OpenCode', 'opencode'],
    ['gemini', 'Google Gemini', 'gemini'],
    ['xai-oauth', 'xAI', 'grok'],
    ['minimax-oauth', 'MiniMax', 'minimax'],
    ['qwen-oauth', 'Qwen', 'qwen'],
    ['copilot-acp', 'GitHub Copilot', 'github-copilot'],
    ['openrouter', 'OpenRouter', 'openrouter'],
    ['mistral', 'Mistral', 'mistral'],
    ['ollama', 'Ollama', 'ollama'],
    ['huggingface', 'Hugging Face', 'hugging-face'],
    ['nvidia', 'NVIDIA', 'nvidia'],
    ['github', 'GitHub', 'github'],
    ['meta', 'Meta', 'meta'],
    ['google-ai', 'Google', 'google']
  ])('maps %s to the real %s mark', (id, label, mark) => {
    const { container } = render(<ProviderMark provider={{ id, label }} />)

    expect(container.querySelector('[data-provider-mark]')?.getAttribute('data-provider-mark')).toBe(mark)
  })

  it('uses the same artwork at rail and row sizes', () => {
    const { container } = render(
      <>
        <ProviderMark provider={{ id: 'openai-codex', label: 'ChatGPT' }} size="sm" />
        <ProviderMark provider={{ id: 'openai-codex', label: 'ChatGPT' }} size="xs" />
      </>
    )
    const marks = container.querySelectorAll('[data-provider-mark="openai"]')

    expect(marks[0]?.className).toContain('size-[1.125rem]')
    expect(marks[1]?.className).toContain('size-3')
  })

  it('falls back to the provider initial only for an unknown family', () => {
    const { container } = render(<ProviderMark provider={{ id: 'future-provider', label: 'Zenith' }} />)

    expect(container.querySelector('[data-provider-mark="fallback"]')?.textContent).toBe('Z')
  })
})
