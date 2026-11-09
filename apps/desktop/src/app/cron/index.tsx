import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import {
  createCronJob,
  deleteCronJob,
  getCronJobRuns,
  getCronJobs,
  pauseCronJob,
  resumeCronJob,
  triggerCronJob,
  updateCronJob
} from '@/hermes'
import { requestModelOptions } from '@/lib/model-options'
import { $cronFocusJobId, $cronJobs, setCronFocusJobId, updateCronJobs } from '@/store/cron'
import { $profileScope, ALL_PROFILES } from '@/store/profile'

import { type CronPageClient, CronPresentation, type CronPresentationProps } from './presentation'

export { type CronPageClient, CronPresentation, type CronPresentationProps } from './presentation'

/** The desktop-shell adapter. Matrix imports CronPresentation directly so its
 * bundled view never reaches this legacy gateway/profile authority. */
export function CronView({ onClose, onOpenSession, setStatusbarItemGroup }: Omit<CronPresentationProps, 'client'>) {
  const jobs = useStore($cronJobs)
  const focusJobId = useStore($cronFocusJobId)
  const profileScope = useStore($profileScope)

  const client = useMemo<CronPageClient>(
    () => ({
      create: createCronJob,
      delete: deleteCronJob,
      getJobs: () => getCronJobs(profileScope === ALL_PROFILES ? 'all' : profileScope),
      getRuns: getCronJobRuns,
      modelOptions: () => requestModelOptions({}),
      pause: pauseCronJob,
      resume: resumeCronJob,
      trigger: triggerCronJob,
      update: updateCronJob
    }),
    [profileScope]
  )

  return (
    <CronPresentation
      client={client}
      focusJobId={focusJobId}
      jobs={jobs}
      onClose={onClose}
      onFocusHandled={() => setCronFocusJobId(null)}
      onJobsChange={next => updateCronJobs(current => (typeof next === 'function' ? next(current) : next))}
      onOpenSession={onOpenSession}
      setStatusbarItemGroup={setStatusbarItemGroup}
    />
  )
}
