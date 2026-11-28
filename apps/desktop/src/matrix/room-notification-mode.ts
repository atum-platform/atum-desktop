import {
  ConditionKind,
  type IPushRule,
  type IPushRules,
  type MatrixClient,
  PushRuleActionName,
  PushRuleKind,
  type Room,
  RuleId
} from 'matrix-js-sdk'

import type { MatrixNotificationOverride, MatrixRoomNotificationMode } from '../../shared/matrix-notification-policy'

const GLOBAL = 'global'

function notifies(rule: IPushRule) {
  return rule.actions.includes(PushRuleActionName.Notify)
}

function roomRules(rules: IPushRules | undefined, roomId: string) {
  const room = rules?.global.room?.find(rule => rule.rule_id === roomId && !rule.default)

  const off = rules?.global.override?.filter(rule => {
    const condition = rule.conditions?.[0]

    return !rule.default && !notifies(rule) && rule.conditions?.length === 1 &&
      condition?.kind === ConditionKind.EventMatch && condition.key === 'room_id' && condition.pattern === roomId
  }) ?? []

  return { room, off }
}

export function readRoomNotificationMode(client: MatrixClient, room: Room): MatrixRoomNotificationMode | undefined {
  if (!client.pushRules) {
    return undefined
  }

  const rules = roomRules(client.pushRules, room.roomId)
  const oneToOne = room.getJoinedMemberCount() === 2

  const defaultId = room.hasEncryptionStateEvent()
    ? (oneToOne ? RuleId.EncryptedDM : RuleId.EncryptedMessage)
    : (oneToOne ? RuleId.DM : RuleId.Message)

  const defaultRule = client.pushRules.global.underride?.find(rule => rule.rule_id === defaultId)

  return {
    mode: rules.off.some(rule => rule.enabled)
      ? 'nothing'
      : rules.room?.enabled ? (notifies(rules.room) ? 'all' : 'mentions') : 'inherit',
    defaultLevel: defaultRule?.enabled && notifies(defaultRule) ? 'all' : 'mentions'
  }
}

/** Put the requested mode before removing the competing rule. A failed request
 * can be retried against the rules the homeserver actually retained. */
export async function writeRoomNotificationMode(
  client: MatrixClient,
  roomId: string,
  mode: MatrixNotificationOverride,
  active: () => boolean
) {
  const rules = roomRules(await client.getPushRules(), roomId)

  function requireActive() {
    if (!active()) {
      throw new Error('matrix_mute_unavailable')
    }
  }

  async function remove(kind: PushRuleKind, id: string) {
    requireActive()
    await client.deletePushRule(GLOBAL, kind, id).catch(error => {
      if (error?.errcode !== 'M_NOT_FOUND') {
        throw error
      }
    })
  }

  requireActive()

  if (mode === 'nothing') {
    await client.addPushRule(GLOBAL, PushRuleKind.Override, roomId, {
      conditions: [{ kind: ConditionKind.EventMatch, key: 'room_id', pattern: roomId }],
      actions: []
    })

    if (rules.off.some(rule => rule.rule_id === roomId && !rule.enabled)) {
      requireActive()
      await client.setPushRuleEnabled(GLOBAL, PushRuleKind.Override, roomId, true)
    }
  } else if (mode !== 'inherit') {
    await client.addPushRule(GLOBAL, PushRuleKind.RoomSpecific, roomId, {
      actions: mode === 'all' ? [PushRuleActionName.Notify] : []
    })

    if (rules.room && !rules.room.enabled) {
      requireActive()
      await client.setPushRuleEnabled(GLOBAL, PushRuleKind.RoomSpecific, roomId, true)
    }
  }

  if (rules.room && (mode === 'inherit' || mode === 'nothing')) {
    await remove(PushRuleKind.RoomSpecific, rules.room.rule_id)
  }

  for (const rule of rules.off) {
    if (mode !== 'nothing' || rule.rule_id !== roomId) {
      await remove(PushRuleKind.Override, rule.rule_id)
    }
  }

  requireActive()
}
