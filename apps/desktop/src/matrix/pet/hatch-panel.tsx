import { useEffect, useId, useRef } from 'react'

import { ProtonText } from '@/components/brand/proton-mark'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useI18n } from '@/i18n'
import { Photo } from '@/lib/icons'

import { petCopy } from '../pet-copy'
import { canGenerateMatrixPet, matrixPetRoundsResetAt } from '../pet-input'
import { microProtons } from '../wallet-ui'

import type { PetHatch } from './hatch'
import type { PetSelection } from './selection'

interface PetHatchPanelProps {
  selection: PetSelection
  hatch: PetHatch
  /** Changes when a hatch is asked for from elsewhere (the Store): the description takes
   * focus once the panel is drawn. 0 leaves focus alone. */
  focusKey?: number
}

export function PetHatchPanel({ selection, hatch: workflow, focusKey = 0 }: PetHatchPanelProps) {
  const { locale } = useI18n()
  const copy = petCopy[locale]
  const { catalog, canEdit, pending, recovery, canDiscardRecovery } = selection
  const describe = useRef<HTMLInputElement>(null)
  const photoHintId = useId()
  const drawn = Boolean(catalog)

  // The panel draws once the catalog is here, which can be after the picker opened.
  useEffect(() => {
    if (focusKey && drawn) {
      describe.current?.focus()
    }
  }, [focusKey, drawn])

  const {
    drafts,
    draft,
    setDraft,
    hatchPrompt,
    setHatchPrompt,
    hatchName,
    setHatchName,
    hatchPhase,
    hatchError,
    photoSelected,
    hatchQuote,
    noRounds,
    generate,
    hatch,
    cancelHatch,
    choosePhoto,
    adoptPending,
    retryPending,
    discardPending
  } = workflow

  const roundsLeft = catalog?.hatch.roundsLeft

  return (
    <>
      {catalog && (
        <div className="space-y-2">
          <p className="text-xs font-medium">{copy.create}</p>
          <p className="text-xs text-muted-foreground">
            {hatchQuote?.kind === 'credit'
              ? copy.hatchCredit
              : hatchQuote
                ? (
                    <ProtonText
                      amounts={[microProtons(hatchQuote.priceMicroProtons, locale)]}
                      text={`${copy.hatchPrice}: ${microProtons(hatchQuote.priceMicroProtons, locale)} ${copy.protons}`}
                      unit={copy.protons}
                    />
                  )
                : copy.limit}
          </p>
          {drafts.length === 0 && roundsLeft !== undefined && (
            <p className="text-xs text-muted-foreground" data-testid="pet-rounds">
              {noRounds
                ? copy.noRounds(matrixPetRoundsResetAt(catalog.serverTime, locale))
                : copy.roundsLeft(roundsLeft)}
            </p>
          )}
          <Input
            aria-label={copy.describe}
            disabled={!canEdit || pending}
            maxLength={300}
            onChange={event => setHatchPrompt(event.target.value)}
            placeholder={copy.describe}
            ref={describe}
            value={hatchPrompt}
          />
          {drafts.length === 0 ? (
            <>
              {/* A photo of a real pet is the other way in, so it sits with the description. */}
              <Button
                aria-describedby={photoHintId}
                className="w-full"
                data-pet-photo
                disabled={!canEdit || pending || noRounds}
                onClick={() => void choosePhoto()}
                size="sm"
                variant="secondary"
              >
                <Photo aria-hidden />
                {photoSelected ? copy.photoChosen : copy.choosePhoto}
              </Button>
              <p className="text-xs text-muted-foreground" data-pet-photo-hint id={photoHintId}>
                {copy.photoHint}
              </p>
              <Button
                disabled={!canEdit || pending || noRounds || !canGenerateMatrixPet(hatchPrompt, photoSelected)}
                onClick={() => void generate()}
                size="sm"
                variant="ghost"
              >
                {copy.generate}
              </Button>
            </>
          ) : (
            <>
              <div className="grid grid-cols-2 gap-1">
                {drafts.map(item => (
                  <Button
                    aria-pressed={draft === item.index}
                    className="overflow-hidden"
                    disabled={!canEdit || pending}
                    key={item.draftId}
                    onClick={() => setDraft(item.index)}
                    size="inline"
                    type="button"
                    variant={draft === item.index ? 'secondary' : 'ghost'}
                  >
                    <img alt={item.summary ?? copy.create} src={item.dataUri} />
                  </Button>
                ))}
              </div>
              <Input
                aria-label={copy.hatch}
                disabled={!canEdit || pending}
                maxLength={100}
                onChange={event => setHatchName(event.target.value)}
                placeholder={copy.hatch}
                value={hatchName}
              />
              <Button
                disabled={!canEdit || pending || draft === undefined || !hatchName.trim() || !hatchQuote}
                onClick={() => void hatch()}
                size="sm"
              >
                {copy.hatch}
              </Button>
            </>
          )}
          {pending && hatchPhase && (
            <Button onClick={cancelHatch} size="sm" variant="text">
              {copy.cancel} · {copy.hatchPhase[hatchPhase]}
            </Button>
          )}
          {hatchError && (
            <p className="text-xs text-muted-foreground">
              {hatchError === 'draft'
                ? copy.draftFailed
                : hatchError === 'limit'
                  ? copy.limit
                  : hatchError === 'priceChanged'
                    ? copy.priceChanged
                    : hatchError === 'refused'
                      ? copy.refused
                      : hatchError === 'conflict'
                        ? copy.conflict
                        : copy.recovering}
            </p>
          )}
          {hatchError === 'conflict' && (
            <Button disabled={pending} onClick={() => void adoptPending()} size="sm" variant="text">
              {copy.acquire}
            </Button>
          )}
          {recovery === 'parked' && (
            <div className="flex gap-1">
              {!canDiscardRecovery && (
                <Button disabled={pending} onClick={() => void retryPending()} size="sm" variant="text">
                  {copy.retryRecovery}
                </Button>
              )}
              {canDiscardRecovery && (
                <Button disabled={pending} onClick={() => void discardPending()} size="sm" variant="text">
                  {copy.discardRecovery}
                </Button>
              )}
            </div>
          )}
          {recovery === 'quarantined' && <p className="text-xs text-muted-foreground">{copy.recoveryQuarantined}</p>}
        </div>
      )}
    </>
  )
}
