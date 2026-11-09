import { cn } from '@/lib/utils'

import appleCalendar from './assets/apple-calendar.png'
import gmail from './assets/gmail.svg'
import googleCalendar from './assets/google-calendar.svg'
import googleDrive from './assets/google-drive.png'

interface ProviderMarkProps extends React.ComponentProps<'span'> {
  /** Names the mark for assistive tech; without it the mark is decorative. */
  label?: string
}

/**
 * One bundled provider mark (no network load). Provider artwork keeps its own colours in
 * both themes (see assets/README.md).
 */
function ProviderMark({ className, label, src, ...props }: ProviderMarkProps & { src: string }) {
  return (
    <span
      {...(label ? { 'aria-label': label, role: 'img' } : { 'aria-hidden': true })}
      className={cn('inline-flex size-4 shrink-0', className)}
      {...props}
    >
      <img alt="" className="size-full" src={src} />
    </span>
  )
}

export function GmailMark(props: ProviderMarkProps) {
  return <ProviderMark src={gmail} {...props} />
}

export function GoogleCalendarMark(props: ProviderMarkProps) {
  return <ProviderMark src={googleCalendar} {...props} />
}

export function DriveMark(props: ProviderMarkProps) {
  return <ProviderMark src={googleDrive} {...props} />
}

export function CalendarMarks({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span aria-hidden className={cn('relative inline-flex h-5 w-7 shrink-0', className)} {...props}>
      <img alt="" className="absolute top-0 left-0 size-4" src={googleCalendar} />
      <img alt="" className="absolute right-0 bottom-0 size-4" src={appleCalendar} />
    </span>
  )
}
