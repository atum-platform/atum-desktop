/*
 * The machine icons, adapted from T3 Code's EnvironmentMachineIcon
 * (apps/web/src/components/EnvironmentMachineIcon.tsx, https://github.com/pingdotgg/t3code at
 * 9c4ab6d47ad340f8286be083b26e18333fe96d1e; Work's fork carries the same file on
 * feat/work-runtime-0.1.16). The dimming follows T3's EnvironmentRow (apps/web/src/components/
 * settings/EnvironmentRow.tsx): only the identity dims. MIT License, Copyright (c) 2026 T3 Tools Inc.
 * The notice is kept in apps/desktop/third-party/licenses/app/t3code-LICENSE.txt.
 *
 * Only the kinds an owner's Mac can be are kept (a laptop, a mini, a studio, else T3's desktop).
 */
import { LaptopIcon, type LucideProps, MonitorIcon } from 'lucide-react'
import type { FunctionComponent, SVGProps } from 'react'

import { cn } from '@/lib/utils'

import type { WorkRelayMachine, WorkRelayMachineKind } from '../../shared/matrix-work-relay'

function LucideLike(props: SVGProps<SVGSVGElement>) {
  return (
    <svg
      fill="none"
      height="24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.75"
      viewBox="0 0 24 24"
      width="24"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    />
  )
}

function MacMiniIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect height="12" rx="2.5" width="18" x="3" y="6" />
      <circle cx="7.5" cy="12" fill="currentColor" r="1" stroke="none" />
    </LucideLike>
  )
}

function MacStudioIcon(props: SVGProps<SVGSVGElement>) {
  return (
    <LucideLike {...props}>
      <rect height="14" rx="2" width="18" x="3" y="5" />
      <path d="M7 15h.01M11 15h.01M15 15h.01" />
    </LucideLike>
  )
}

const ICON_BY_KIND: Record<WorkRelayMachineKind, FunctionComponent<LucideProps>> = {
  desktop: MonitorIcon,
  laptop: LaptopIcon,
  'mac-mini': MacMiniIcon,
  'mac-studio': MacStudioIcon
}

export function MachineIcon({ kind, ...props }: LucideProps & { readonly kind: WorkRelayMachineKind }) {
  const Icon = ICON_BY_KIND[kind]

  return <Icon {...props} />
}

/**
 * The Macs a plan model answers through, one icon each, after the row's name: as T3's machine rows,
 * an online Mac in muted ink and an offline one dimmed. The row's label and tooltip say the same in
 * words, so the icons are decoration for assistive technology.
 */
export function MachineIcons({ machines, className }: { machines: readonly WorkRelayMachine[]; className?: string }) {
  if (!machines.length) {
    return null
  }

  return (
    <span aria-hidden className={cn('flex shrink-0 items-center gap-1', className)} data-matrix-model-machines>
      {machines.map(machine => (
        <MachineIcon
          className={cn('size-3.5 text-(--atum-ink-muted)', !machine.online && 'opacity-40')}
          data-matrix-model-machine={machine.id}
          data-matrix-model-machine-kind={machine.kind}
          data-matrix-model-machine-online={machine.online ? 'true' : 'false'}
          key={machine.id}
          kind={machine.kind}
          strokeWidth={1.75}
        />
      ))}
    </span>
  )
}
