import { Button } from '@/components/ui/button'
import { Codicon } from '@/components/ui/codicon'
import { Switch } from '@/components/ui/switch'
import { Tip } from '@/components/ui/tooltip'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

/** Shared transport-free controls for legacy and selected-agent MCP views. */
// Tracks configured enabled state, not connection liveness (the status dot).
export function ServerSwitch({
  className,
  disabled,
  enabled,
  name,
  onToggle
}: {
  className?: string
  disabled: boolean
  enabled: boolean
  name: string
  onToggle: (checked: boolean) => void
}) {
  const { t } = useI18n()
  const label = enabled ? t.settings.mcp.disableServer(name) : t.settings.mcp.enableServer(name)

  return (
    <Tip label={label}>
      <Switch
        aria-label={label}
        checked={enabled}
        className={cn('shrink-0', !enabled && 'opacity-60', className)}
        disabled={disabled}
        onCheckedChange={onToggle}
        size="xs"
      />
    </Tip>
  )
}

/** Test + delete controls shared by rows and config headers. */
export function ServerIconActions({
  className,
  onProbe,
  onRemove,
  probing,
  saving
}: {
  className?: string
  onProbe: () => void
  onRemove: () => void
  probing: boolean
  saving: boolean
}) {
  const { t } = useI18n()
  const m = t.settings.mcp

  return (
    <span className={cn('flex items-center gap-0.5', className)}>
      <Tip label={m.test}>
        <Button aria-label={m.test} disabled={probing || saving} onClick={onProbe} size="icon-xs" variant="ghost">
          <Codicon name="refresh" spinning={probing} />
        </Button>
      </Tip>
      <Tip label={m.remove}>
        <Button aria-label={m.remove} disabled={saving || probing} onClick={onRemove} size="icon-xs" variant="ghost">
          <Codicon name="trash" />
        </Button>
      </Tip>
    </span>
  )
}
