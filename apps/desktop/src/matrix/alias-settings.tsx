import { useId, useState } from 'react'

import { useI18n } from '@/i18n'
import { ChevronDown } from '@/lib/icons'

import type { MatrixAgentView } from '../../shared/matrix'
import { matrixAliasCopy } from '../../shared/matrix-alias-copy'
import type { MatrixAliasBridge } from '../../shared/matrix-aliases'

import { MatrixHandleEditor } from './handle-editor'
import { suggestMatrixAgentHandle } from './handle-rules'
import { rememberAgentHandle } from './person-handles'
import { SettingsRow, SettingsSection } from './settings-row'

interface AliasSettingsProps {
  accountKey: string
  agents: MatrixAgentView[]
  bridge: MatrixAliasBridge
}

/**
 * Settings › Account › Public handle: a section with the chosen person's or assistant's
 * handle, which can be chosen or changed there (`MatrixHandleEditor`). The choice of whose
 * handle shows only when there are assistants to choose from. Remount account/target caches
 * together; a pending change remains native-owned.
 */
export function MatrixAliasSettings(props: AliasSettingsProps) {
  const { locale } = useI18n()
  const copy = matrixAliasCopy(locale)
  const [selected, setSelected] = useState('')
  const targets = props.agents.filter(agent => agent.assistantId)
  const target = targets.find(agent => agent.assistantId === selected)
  const id = useId()

  return (
    <SettingsSection data-matrix-alias-settings help={copy.help} title={copy.title}>
      {targets.length > 0 && (
        <SettingsRow
          control={
            <span className="atum-settings-select">
              <select id={id} onChange={event => setSelected(event.target.value)} value={target?.assistantId ?? ''}>
                <option value="">{copy.person}</option>
                {targets.map(agent => (
                  <option key={agent.assistantId} value={agent.assistantId}>
                    {agent.name ?? copy.assistant}
                  </option>
                ))}
              </select>
              <ChevronDown aria-hidden />
            </span>
          }
          title={<label htmlFor={id}>{copy.target}</label>}
        />
      )}
      <MatrixHandleEditor
        assistantId={target?.assistantId}
        bridge={props.bridge}
        key={`${props.accountKey}:${target?.assistantId ?? ''}`}
        name={target?.name ?? copy.assistant}
        names={targets}
        onChanged={(handle, previous) => target && rememberAgentHandle(target.userId, handle, previous)}
        suggestion={target ? suggestMatrixAgentHandle(target.name) : undefined}
      />
    </SettingsSection>
  )
}
