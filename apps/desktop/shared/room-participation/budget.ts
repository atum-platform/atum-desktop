import { DAILY_TURNS_MAX, DAILY_TURNS_MIN } from './limits'
import { parseRoomUsage } from './policy'
import type { BudgetDecision, BudgetFacts, RoomUsage } from './types'

export function roomBudget({ now, dailyTurns, usage }: BudgetFacts): BudgetDecision {
  if (
    !Number.isSafeInteger(now) ||
    now < 0 ||
    !Number.isSafeInteger(dailyTurns) ||
    dailyTurns < DAILY_TURNS_MIN ||
    dailyTurns > DAILY_TURNS_MAX ||
    !parseRoomUsage(usage).ok
  ) {
    throw new Error('invalid_room_budget')
  }

  const day = new Date(now).toISOString().slice(0, 10)
  const sameDay = usage.day === day
  const turns = sameDay ? usage.turns : 0

  return {
    day,
    turns,
    cap: dailyTurns,
    remaining: Math.max(0, dailyTurns - turns),
    allowed: turns < dailyTurns,
    notice: turns >= dailyTurns && !(sameDay && usage.pausedNoticed)
  }
}

/** An advisory SDK update only; the ledger transaction is the hard multi-Mac cap. */
export function usageAfterClaim(usage: RoomUsage, budget: BudgetDecision): RoomUsage {
  if (!budget.allowed) {
    throw new Error('room_cap')
  }

  return {
    ...usage,
    v: 1,
    day: budget.day,
    turns: budget.turns + 1,
    pausedNoticed: usage.day === budget.day && usage.pausedNoticed === true
  }
}
