import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { ExternalLink } from '@/lib/external-link'
import { PawPrint, Settings2 } from '@/lib/icons'

interface GenerateUnavailableProps {
  onSetup: () => void
  /** Which way to hatch is missing its backend. */
  lane?: 'voxel' | 'illustrated'
  /** The gateway's reason, when it gave one (e.g. no hatch alias yet). */
  reason?: string
}

// Shown when the chosen lane has no backend: the spec path needs a model the
// pet_hatch task can reach (the metered lane's hatch alias, or the user's own
// key); the illustrated path needs a reference-capable image provider. We
// replace the prompt entirely with a friendly path to set one up (in-app)
// plus where to grab a key.
export function GenerateUnavailable({ lane = 'illustrated', onSetup, reason }: GenerateUnavailableProps) {
  const { t } = useI18n()
  const copy = t.commandCenter.generatePet
  const voxel = lane === 'voxel'

  return (
    <div className="flex flex-col items-center gap-4 text-center" data-atum-pet-unavailable={lane}>
      <span className="grid size-11 place-items-center rounded-full bg-primary/10 text-primary">
        <PawPrint className="size-5" />
      </span>
      <div className="space-y-1.5">
        <p className="text-[length:var(--conversation-text-font-size)] font-semibold">
          {voxel ? copy.voxelUnavailableTitle : 'Add an image backend to generate'}
        </p>
        <p className="mx-auto max-w-[19rem] text-[length:var(--conversation-caption-font-size)] leading-relaxed text-(--ui-text-tertiary)">
          {voxel ? copy.voxelUnavailableBody : 'Hatching a custom pet needs a provider that can ground on a reference image.'}
        </p>
        {voxel && reason ? <p className="text-[0.6875rem] text-(--ui-text-tertiary)">{reason}</p> : null}
      </div>
      <Button onClick={onSetup} size="sm">
        <Settings2 className="size-4" />
        {voxel ? copy.voxelUnavailableAction : 'Set up image generation'}
      </Button>
      <p className="flex flex-wrap items-center justify-center gap-x-1.5 text-[0.6875rem] text-(--ui-text-tertiary)">
        <span>Grab a key from</span>
        <ExternalLink href="https://portal.nousresearch.com" showExternalIcon={false}>
          Nous Portal
        </ExternalLink>
        <span>·</span>
        <ExternalLink
          className="opacity-40 transition-opacity hover:opacity-100"
          href="https://openrouter.ai/keys"
          showExternalIcon={false}
        >
          OpenRouter
        </ExternalLink>
        <span>·</span>
        <ExternalLink
          className="opacity-40 transition-opacity hover:opacity-100"
          href="https://platform.openai.com/api-keys"
          showExternalIcon={false}
        >
          OpenAI
        </ExternalLink>
      </p>
    </div>
  )
}
