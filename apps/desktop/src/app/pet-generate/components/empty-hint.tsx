import { useStore } from '@nanostores/react'

import { Button } from '@/components/ui/button'
import { $petGenStyle } from '@/store/pet-generate'

interface EmptyHintProps {
  onExample: (prompt: string) => void
}

// Creative seed prompts — specifics make better pets (petdex's own advice).
// Short chips that wrap into a tight, centered cluster (capped width → 2 rows).
// The voxel path hatches dogs, so its seeds are dogs; the illustrated path
// draws anything.
const EXAMPLE_PROMPTS = ['bubble-tea otter', 'sock elf', 'pixel dragon', 'office cat', 'neon axolotl', 'moss golem']
const DOG_PROMPTS = ['scruffy grey terrier', 'golden retriever puppy', 'spotted dalmatian', 'black-and-tan dachshund', 'fluffy white samoyed', 'brindle boxer']

export function EmptyHint({ onExample }: EmptyHintProps) {
  const style = useStore($petGenStyle)
  const prompts = style === 'voxel' ? DOG_PROMPTS : EXAMPLE_PROMPTS
  return (
    <div className="flex max-w-[300px] flex-wrap place-content-center place-items-center gap-2">
      {prompts.map(example => (
        <Button
          className="h-auto w-fit rounded-full font-normal"
          key={example}
          onClick={() => onExample(`a ${example}`)}
          size="xs"
          variant="outline"
        >
          {example}
        </Button>
      ))}
    </div>
  )
}
