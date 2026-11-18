// Synthetic data only. Render the production popover, panel, disclosure and stylesheet.
import React, { useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import { I18nProvider } from '../../src/i18n'
import { ModelPickerPopover, pickerRouteOf } from '../../src/matrix/model-picker-popover'
import { MODEL_PICKER_CARD_COMPACT, ModelPickerPanel, useModelPickerKeys } from '../../src/matrix/model-picker-panel'
import { ChatGptTrainingConfirm } from '../../src/matrix/chatgpt-training-confirm'
import '../../src/styles.css'

function Proof() {
  const params = new URLSearchParams(location.search)
  const count = Number(params.get('rows') || 15)
  const [selected, setSelected] = useState('')
  const list = useRef(null)
  const search = useRef(null)
  const keys = useModelPickerKeys(list, search)
  const routes = Array.from({ length: count }, (_, index) =>
    pickerRouteOf({
      provider: 'openrouter',
      providerLabel: 'OpenRouter',
      model: `synthetic-${index + 1}`
    })
  )
  return (
    <I18nProvider configClient={null} initialLocale={params.get('locale') || 'en'}>
      <output data-proof-selection>{selected}</output>
      {params.has('takeover') ? (
        <div className={MODEL_PICKER_CARD_COMPACT} data-proof-card>
          <ModelPickerPanel
            filter={{ favoritesOnly: false }}
            sources={[]}
            onFilterChange={() => {}}
            query=""
            onQueryChange={() => {}}
            listRef={list}
            searchRef={search}
            keys={keys}
            takeover={
              <ChatGptTrainingConfirm
                training={{ connectionId: 'synthetic', current: false }}
                bridge={{
                  confirmChatGptTraining: async () => ({
                    status: 'confirmed',
                    training: { current: true, connectionId: 'synthetic' }
                  })
                }}
                onConfirmed={() => setSelected('confirmed')}
                onKeep={() => setSelected('kept')}
              />
            }
          />
        </div>
      ) : (
        <ModelPickerPopover
          routes={routes}
          scope="synthetic-layout-proof"
          label="Choose model"
          placeholder="Choose model"
          onChoose={route => setSelected(route.model)}
        />
      )}
    </I18nProvider>
  )
}
createRoot(document.getElementById('root')).render(<Proof />)
