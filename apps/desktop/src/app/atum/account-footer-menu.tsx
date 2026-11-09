import { useStore } from '@nanostores/react'
import { type ReactNode, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

import { SETTINGS_ROUTE } from '@/app/routes'
import { ProtonMark } from '@/components/brand/proton-mark'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useI18n } from '@/i18n'
import { AppWindow, Eye, EyeOff, LogOut, Monitor, PawPrint, Settings, UserCircle, Users } from '@/lib/icons'
import { $atumAccountStatus, signOutOfAtum } from '@/store/atum-messaging'
import { $atumShellEnabled } from '@/store/atum-shell'
import { $petInfo } from '@/store/pet'
import { togglePetEnabled } from '@/store/pet-gallery'
import { $petOverlayActive, popInPet, popOutPetFromMenu } from '@/store/pet-overlay'
import { $gatewaySwapTarget } from '@/store/profile'

import { useGatewayRequest } from '../gateway/hooks/use-gateway-request'
import { petSettingsHref } from '../settings/pet-settings'

import { AtumAccountDialog } from './account-menu'
import { useOpenStorefront } from './use-open-storefront'

/**
 * The account menu, off the whole footer row. The shape every desktop
 * assistant's account menu has settled on: who you are at the top (opens the
 * account sheet), then what your account gives you — Protons, the pet, inviting
 * someone — then Settings and signing out.
 *
 * The pet row is a submenu rather than a single toggle because there are two
 * independent questions — is there a pet at all, and does it live in the window
 * or on the desktop — and collapsing them into one switch makes "off" ambiguous.
 * It carries the same verbs as right-clicking the pet itself. The Protons row
 * opens Protons settings and never shows a balance: the menu stays about the
 * account, not about what is left to spend.
 */
export function AtumAccountMenu({
  children,
  anchorState = 'sidebar'
}: {
  children: ReactNode
  anchorState?: 'hidden' | 'drawer' | 'sidebar'
}) {
  const { t } = useI18n()
  const navigate = useNavigate()
  const openStorefront = useOpenStorefront()
  const account = useStore($atumAccountStatus)
  const { requestGateway } = useGatewayRequest()
  const petInfo = useStore($petInfo)
  const petPoppedOut = useStore($petOverlayActive)
  const atumShell = useStore($atumShellEnabled)
  const petOn = Boolean(petInfo.enabled)
  // These act on the gateway profile, which lags the chat in front while a
  // profile's backend is still connecting. Acting then would pop out (or hide)
  // the *previous* assistant's pet, so the rows wait the swap out.
  const swapping = useStore($gatewaySwapTarget) !== null
  const [open, setOpen] = useState(false)
  const [profileOpen, setProfileOpen] = useState(false)
  useEffect(() => {
    setOpen(false)
  }, [anchorState])

  const setPetOn = (on: boolean) => {
    const petCopy = t.settings.appearance.pet

    void togglePetEnabled(requestGateway, on, {
      fallback: on ? petCopy.turnOnFailed : petCopy.turnOffFailed,
      noneAvailable: petCopy.noneAvailable
    })
  }

  const name = account.account?.displayName || account.account?.handle || t.atum.account.title
  const handle = account.account?.handle ? `@${account.account.handle}` : null

  return (
    <>
      <DropdownMenu onOpenChange={setOpen} open={anchorState !== 'hidden' && open}>
        <DropdownMenuTrigger asChild>{children}</DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="w-64"
          data-atum-account-menu
          onCloseAutoFocus={event => {
            if (anchorState === 'hidden') {
              event.preventDefault()
            }
          }}
          side="top"
        >
          <DropdownMenuItem
            className="items-center gap-2.5 py-2"
            data-atum-account-profile
            onSelect={() => setProfileOpen(true)}
          >
            <span className="grid size-7 shrink-0 place-items-center overflow-hidden rounded-(--atum-r-control) bg-(--atum-sunk) text-(length:--atum-t-caption) font-medium">
              {account.account?.avatarUrl ? (
                <img alt="" className="size-full object-cover" src={account.account.avatarUrl} />
              ) : (
                <UserCircle aria-hidden className="size-4" />
              )}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium text-(--atum-ink)">{name}</span>
              {handle && (
                <span className="block truncate text-(length:--atum-t-caption) text-(--atum-ink-muted)">{handle}</span>
              )}
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-atum-menu-usage onSelect={() => navigate(`${SETTINGS_ROUTE}?tab=atum:protons`)}>
            <ProtonMark />
            {t.atum.protons.title}
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger data-atum-menu-pet>
              <PawPrint aria-hidden />
              {t.atum.account.pet}
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent className="w-52">
              <DropdownMenuItem data-atum-menu-pet-visibility disabled={swapping} onSelect={() => setPetOn(!petOn)}>
                {petOn ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
                {petOn ? t.atum.pet.hide : t.atum.pet.show}
              </DropdownMenuItem>
              {/* Where the pet lives is only a question once there is one. */}
              <DropdownMenuItem
                data-atum-menu-pet-place
                disabled={!petOn || swapping}
                onSelect={() => (petPoppedOut ? popInPet() : popOutPetFromMenu())}
              >
                {petPoppedOut ? <AppWindow aria-hidden /> : <Monitor aria-hidden />}
                {petPoppedOut ? t.atum.pet.putBack : t.atum.pet.popOut}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem data-atum-menu-pet-store onSelect={() => openStorefront('pets')}>
                <PawPrint aria-hidden />
                {t.atum.pet.store}
              </DropdownMenuItem>
              {/* petSettingsHref picks the view id the settings page actually
                  accepts for this shell (a `?tab=` it doesn't know would be
                  silently coerced to the default view) and anchors the pet
                  section so the person lands on it, not the top of General. */}
              <DropdownMenuItem data-atum-menu-pet-settings onSelect={() => navigate(petSettingsHref(atumShell))}>
                <Settings aria-hidden />
                {t.atum.pet.settings}
              </DropdownMenuItem>
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuItem data-atum-menu-invite onSelect={() => openStorefront('people')}>
            <Users aria-hidden />
            {t.atum.account.invite}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem data-atum-nav-settings onSelect={() => navigate(SETTINGS_ROUTE)}>
            <Settings aria-hidden />
            {t.atum.nav.settings}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => void signOutOfAtum()}>
            <LogOut aria-hidden />
            {t.dm.signOut}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {profileOpen && <AtumAccountDialog onOpenChange={setProfileOpen} open={profileOpen} />}
    </>
  )
}
