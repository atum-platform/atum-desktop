export type ProtonRewardKind = 'email' | 'calendar'
export interface ProtonRewards {
  version: 1
  state: 'paused' | 'available'
  total_earned_protons: number
  tasks: Array<{ kind: ProtonRewardKind; amount_protons: number; earned_at: string | null }>
}
export interface ProtonRewardClaim {
  state: 'earned' | 'already_earned' | 'connection_already_rewarded'
  amount_protons: number
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) { throw new Error('proton_rewards_invalid') }

  return value as Record<string, unknown>
}

export function parseProtonRewards(value: unknown): ProtonRewards {
  const data = object(value)

  if (data.version !== 1 || !['paused', 'available'].includes(String(data.state))
    || !Array.isArray(data.tasks) || data.tasks.length !== 2) { throw new Error('proton_rewards_invalid') }

  const tasks = data.tasks.map(value => {
    const task = object(value)

    if (!['email', 'calendar'].includes(String(task.kind)) || task.amount_protons !== 3000
      || (task.earned_at !== null && (typeof task.earned_at !== 'string' || task.earned_at.length > 40 || !Number.isFinite(Date.parse(task.earned_at))))) {
      throw new Error('proton_rewards_invalid')
    }

    return { kind: task.kind as ProtonRewardKind, amount_protons: task.amount_protons as number, earned_at: task.earned_at as string | null }
  })

  if (new Set(tasks.map(task => task.kind)).size !== 2
    || data.total_earned_protons !== tasks.reduce((sum, task) => sum + (task.earned_at ? task.amount_protons : 0), 0)) {
    throw new Error('proton_rewards_invalid')
  }

  return { version: 1, state: data.state as ProtonRewards['state'], total_earned_protons: data.total_earned_protons as number, tasks }
}

export function parseProtonRewardClaim(value: unknown): ProtonRewardClaim {
  const data = object(value)

  if (!['earned', 'already_earned', 'connection_already_rewarded'].includes(String(data.state))
    || data.amount_protons !== (data.state === 'earned' ? 3000 : 0)) { throw new Error('proton_rewards_invalid') }

  return { state: data.state as ProtonRewardClaim['state'], amount_protons: data.amount_protons as number }
}
