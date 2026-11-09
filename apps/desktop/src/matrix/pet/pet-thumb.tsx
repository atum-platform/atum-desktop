import { useId } from 'react'
import type * as React from 'react'

import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n'
import { PawPrint } from '@/lib/icons'

import type { MatrixPetCatalogItem } from '../../../shared/matrix-pet'
import { petCopy } from '../pet-copy'
import { storePetPreview } from '../store/pet-previews'

interface PetThumbProps extends Omit<React.ComponentProps<typeof Button>, 'variant' | 'size'> {
  item: MatrixPetCatalogItem
  selected?: boolean
}

export function PetThumb({ item, selected = false, children, ...props }: PetThumbProps) {
  const { locale } = useI18n()
  const descriptionId = useId()
  const preview = item.ref.kind === 'bundled' ? storePetPreview(`pet/${item.ref.slug}`) : undefined

  return (
    <Button
      aria-describedby={descriptionId}
      aria-label={item.name}
      aria-pressed={selected}
      className="w-full justify-start"
      size="sm"
      variant={selected ? 'secondary' : 'ghost'}
      {...props}
    >
      {preview ? (
        <img alt="" className="h-10 w-12 shrink-0 object-contain" src={preview} />
      ) : (
        <PawPrint aria-hidden className="size-8" />
      )}
      <span className="min-w-0 flex-1 text-left">
        <span className="block truncate">{item.name}</span>
        <span className="block text-xs font-normal text-muted-foreground" id={descriptionId}>
          {petCopy[locale][item.access]}
        </span>
        {children && <span className="block text-xs font-normal text-muted-foreground">{children}</span>}
      </span>
    </Button>
  )
}
