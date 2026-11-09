import type { ReactNode } from 'react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { CreditCard, LayoutDashboard, LogOut, Mail, Plus, Settings } from '@/lib/icons'
import { useKeybindHint } from '@/lib/keybinds/use-keybind-hint'

import { matrixCompanyBoardCopy } from '../../../shared/matrix-company-board-copy'
import { RosterBadge } from '../roster-badge'
import type { MatrixRosterBadge } from '../roster-preview'

import { companyInitials } from './company-switcher'
import { useTeamSpaceCopy } from './copy'
import { useTeamSpaceLayoutCopy } from './layout-copy'

/** What the viewer may do from the menu; an entry they may not use is not drawn (never drawn disabled). */
export interface CompanyMenuAllowed {
  overview: boolean
  invite: boolean
  settings: boolean
  members: boolean
  create: boolean
  leave: boolean
  /** The company wallet belongs to the company menu, and only to owners and admins. */
  wallet: boolean
}

export interface CompanyMenuCompany {
  id: string
  displayName: string
  role: 'admin' | 'member'
  badge: MatrixRosterBadge
  avatarUrl?: string
}

export interface CompanyMenuProps {
  /** The trigger: the sidebar's title button. */
  children: ReactNode
  /** In the order every switcher surface shares. */
  companies: readonly CompanyMenuCompany[]
  currentId: string | undefined
  allowed: CompanyMenuAllowed
  /** A change is running: switching and creating wait for it. */
  disabled: boolean
  onSwitch(companyId: string): void
  onOverview(): void
  onInvite(): void
  onSettings(): void
  /** Legacy caller compatibility; member navigation is consolidated in Company overview. */
  onMembers?(): void
  onCreate(): void
  onLeave(): void
  onWallet(): void
}

/**
 * One company in the menu: its squircle (the same two letters the tile column used to show) and its name, with the
 * shortcut that switches to it. The checked mark and the badge are the menu's own.
 */
function CompanyMenuOption({ company, disabled, index, locale }: {
  company: CompanyMenuCompany
  disabled: boolean
  index: number
  locale: string
}) {
  // Companies past the ninth have no shortcut, so no hint (an unknown action id reads as none).
  const hint = useKeybindHint(`nav.company.${index + 1}`)
  const { company: copy } = useTeamSpaceCopy()

  return (
    <DropdownMenuRadioItem
      aria-label={`${company.displayName} · ${company.role === 'admin' ? copy.admin : copy.member}`}
      data-company-id={company.id}
      disabled={disabled}
      value={company.id}
    >
      {company.avatarUrl ? (
        <img alt="" className="atum-avatar size-5 shrink-0 object-cover" src={company.avatarUrl} />
      ) : (
        <span
          aria-hidden
          className="atum-avatar grid size-5 shrink-0 place-items-center bg-(--atum-sunk) text-[0.625rem] font-semibold text-(--atum-ink)"
          data-company-initials
        >
          {companyInitials(company.displayName, locale)}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate">{company.displayName}</span>
      {company.badge && <RosterBadge badge={company.badge} />}
      {hint && <DropdownMenuShortcut aria-hidden>{hint}</DropdownMenuShortcut>}
    </DropdownMenuRadioItem>
  )
}

/**
 * The company name is always a menu, even with one company: the companies to switch between (the one on screen
 * checked), then what this person may do in it. Switching and creating live here, so the window never draws a
 * second rail beside the sidebar.
 */
export function CompanyMenu({
  allowed,
  children,
  companies,
  currentId,
  disabled,
  onCreate,
  onInvite,
  onLeave,
  onOverview,
  onSettings,
  onSwitch,
  onWallet
}: CompanyMenuProps) {
  const { company, team } = useTeamSpaceCopy()
  const layout = useTeamSpaceLayoutCopy()
  const { locale } = useI18n()
  const board = matrixCompanyBoardCopy(locale)
  const inCompany = allowed.overview || allowed.invite || allowed.settings || allowed.members
  const exits = allowed.create || allowed.leave

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-60" data-matrix-company-menu>
        {companies.length > 0 && (
          <>
            <DropdownMenuLabel>{company.companies}</DropdownMenuLabel>
            <DropdownMenuRadioGroup
              onValueChange={id => {
                if (id !== currentId) {
                  onSwitch(id)
                }
              }}
              value={currentId ?? ''}
            >
              {companies.map((item, index) => (
                <CompanyMenuOption
                  company={item}
                  disabled={disabled}
                  index={index}
                  key={item.id}
                  locale={locale}
                />
              ))}
            </DropdownMenuRadioGroup>
            {(inCompany || exits) && <DropdownMenuSeparator />}
          </>
        )}
        {allowed.overview && (
          <DropdownMenuItem onSelect={onOverview}>
            <LayoutDashboard aria-hidden />
            {company.companyOverview}
          </DropdownMenuItem>
        )}
        {allowed.wallet && (
          <DropdownMenuItem onSelect={onWallet}>
            <CreditCard aria-hidden />
            {board.wallet}
          </DropdownMenuItem>
        )}
        {allowed.invite && (
          <DropdownMenuItem onSelect={onInvite}>
            <Mail aria-hidden />
            {team.invitePeople}
          </DropdownMenuItem>
        )}
        {allowed.settings && (
          <DropdownMenuItem onSelect={onSettings}>
            <Settings aria-hidden />
            {team.companySettings}
          </DropdownMenuItem>
        )}
        {inCompany && exits && <DropdownMenuSeparator />}
        {allowed.create && (
          <DropdownMenuItem disabled={disabled} onSelect={onCreate}>
            <Plus aria-hidden />
            {layout.addCompany}
          </DropdownMenuItem>
        )}
        {allowed.leave && (
          <DropdownMenuItem onSelect={onLeave} variant="destructive">
            <LogOut aria-hidden />
            {team.leaveCompany}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
