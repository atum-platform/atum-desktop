import {
  SiGithub,
  SiGoogle,
  SiHuggingface,
  SiMeta,
  SiMistralai,
  SiNvidia,
  SiOllama,
  SiOpenrouter
} from '@icons-pack/react-simple-icons'
import type { ComponentType, CSSProperties, SVGProps } from 'react'

import { BrandTile, type BrandTileSize } from '@/components/brand/brand-tile'
import { cn } from '@/lib/utils'

import type { PickerProvider } from './model-picker-sections'
import claudeMark from './provider-marks/claude.svg'
import deepSeekMark from './provider-marks/deepseek.svg'
import geminiMark from './provider-marks/gemini.svg'
import copilotMark from './provider-marks/github-copilot.svg'
import grokMark from './provider-marks/grok.svg'
import minimaxMark from './provider-marks/minimax.svg'
import openAiMark from './provider-marks/openai.svg'
import openCodeMark from './provider-marks/opencode.svg'
import qwenMark from './provider-marks/qwen.svg'

interface ProviderIconSpec {
  key: string
  asset?: string
  color?: string
  Icon?: ComponentType<SVGProps<SVGSVGElement>>
  monogram?: string
}

const PROVIDER_ICONS: ReadonlyArray<{ matches: readonly string[]; icon: ProviderIconSpec }> = [
  {
    matches: ['openai-codex', 'openai-api', 'chatgpt', 'codex', 'openai'],
    icon: { key: 'openai', asset: openAiMark }
  },
  { matches: ['anthropic', 'claude'], icon: { key: 'claude', asset: claudeMark, color: '#D97757' } },
  { matches: ['deepseek'], icon: { key: 'deepseek', asset: deepSeekMark, color: '#5786FE' } },
  { matches: ['opencode'], icon: { key: 'opencode', asset: openCodeMark } },
  { matches: ['gemini'], icon: { key: 'gemini', asset: geminiMark, color: '#8E75B2' } },
  { matches: ['xai', 'grok'], icon: { key: 'grok', asset: grokMark } },
  { matches: ['minimax'], icon: { key: 'minimax', asset: minimaxMark, color: '#E73562' } },
  { matches: ['qwen'], icon: { key: 'qwen', asset: qwenMark, color: '#6950EF' } },
  { matches: ['copilot-acp', 'github copilot', 'copilot'], icon: { key: 'github-copilot', asset: copilotMark } },
  { matches: ['google-ai', 'google'], icon: { key: 'google', Icon: SiGoogle } },
  { matches: ['openrouter'], icon: { key: 'openrouter', Icon: SiOpenrouter } },
  { matches: ['mistral'], icon: { key: 'mistral', Icon: SiMistralai } },
  { matches: ['ollama'], icon: { key: 'ollama', Icon: SiOllama } },
  { matches: ['huggingface', 'hugging-face'], icon: { key: 'hugging-face', Icon: SiHuggingface } },
  { matches: ['nvidia'], icon: { key: 'nvidia', Icon: SiNvidia } },
  { matches: ['github'], icon: { key: 'github', Icon: SiGithub } },
  { matches: ['meta', 'llama'], icon: { key: 'meta', Icon: SiMeta } }
]

const MARK_SIZE: Record<BrandTileSize, string> = {
  xs: 'size-3',
  sm: 'size-[1.125rem]',
  md: 'size-7'
}

function providerIconSpec(provider: string, label: string): ProviderIconSpec {
  const identity = `${provider} ${label}`.toLocaleLowerCase()
  const match = PROVIDER_ICONS.find(({ matches }) => matches.some(part => identity.includes(part)))

  return match?.icon ?? { key: 'fallback', monogram: label }
}

interface ProviderMarkProps {
  provider: PickerProvider
  size?: BrandTileSize
}

/**
 * A provider's real bundled mark. Known marks render from local SVG masks, so monochrome marks
 * follow the theme while Claude/Gemini/DeepSeek/MiniMax/Qwen retain their identifying colour.
 * Unknown providers alone fall back to the first letter in the shared sunk tile.
 */
export function ProviderMark({ provider, size = 'sm' }: ProviderMarkProps) {
  const spec = providerIconSpec(provider.id, provider.label)
  const className = MARK_SIZE[size]

  if (spec.asset) {
    const mask: CSSProperties = {
      backgroundColor: spec.color ?? 'currentColor',
      maskImage: `url("${spec.asset}")`,
      maskPosition: 'center',
      maskRepeat: 'no-repeat',
      maskSize: 'contain',
      WebkitMaskImage: `url("${spec.asset}")`,
      WebkitMaskPosition: 'center',
      WebkitMaskRepeat: 'no-repeat',
      WebkitMaskSize: 'contain'
    }

    return (
      <span aria-hidden className={cn('inline-block shrink-0', className)} data-provider-mark={spec.key} style={mask} />
    )
  }

  if (spec.Icon) {
    const Icon = spec.Icon

    return <Icon aria-hidden className={cn('shrink-0', className)} data-provider-mark={spec.key} />
  }

  return <BrandTile data-provider-mark="fallback" monogram={spec.monogram} size={size} />
}
