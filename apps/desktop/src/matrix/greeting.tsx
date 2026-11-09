import { AtumAssistantAvatar } from '@/app/atum/assistant-avatar'
import { useI18n } from '@/i18n'

/** The time of day's greeting: morning from 5, afternoon from noon, evening from 6 pm. */
export function greetingFor(hour: number): 'greetMorning' | 'greetAfternoon' | 'greetEvening' {
  if (hour >= 5 && hour < 12) {
    return 'greetMorning'
  }

  return hour >= 12 && hour < 18 ? 'greetAfternoon' : 'greetEvening'
}

export interface MatrixGreetingStarter {
  label: string
  text: string
  onPick(): void
}

/**
 * An assistant's empty chat, as the approved welcome design draws the window it opens on:
 * the assistant's mark, the time of day's greeting and one line of invitation, centred
 * above the composer, followed by three starters that fill the message box without sending.
 */
export function AssistantGreeting({
  brand,
  id,
  name,
  starters
}: {
  brand: boolean
  id: string
  name: string
  starters?: readonly MatrixGreetingStarter[]
}) {
  const shell = useI18n().t.matrixShell

  return (
    <div className="flex flex-col items-center justify-center self-center text-center" data-matrix-greeting>
      <AtumAssistantAvatar brand={brand} className="size-(--atum-avatar-lg) rounded-full" id={id} name={name} />
      <p className="atum-greeting mt-(--ak-s4)">{shell[greetingFor(new Date().getHours())]}</p>
      <p className="mt-(--ak-s2) [font:var(--ak-t-body)] text-(--ak-ink-2)">{shell.greetPrompt}</p>
      {starters && starters.length > 0 && (
        <div className="mt-6 flex max-w-[34rem] flex-wrap justify-center gap-2" data-matrix-starters>
          {starters.map(starter => (
            <button
              className="h-8 rounded-full border border-(--atum-line) px-3.5 text-(length:--atum-t-control) text-(--atum-ink-soft) transition-colors duration-150 hover:bg-(--atum-hover) hover:text-(--atum-ink)"
              key={starter.label}
              onClick={starter.onPick}
              type="button"
            >
              {starter.label}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
