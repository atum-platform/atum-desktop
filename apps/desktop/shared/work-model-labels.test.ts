import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

import { expect, it } from 'vitest'

import { MATRIX_MODEL_LINEUP, matrixModelName } from './matrix-models'

it('uses the product name for every selectable Work model and preserves unknown provider labels', () => {
  const output = execFileSync('python3', ['-I', '-B', '-c', `
import importlib.util, json, sys
spec = importlib.util.spec_from_file_location('model_labels', sys.argv[1])
labels = importlib.util.module_from_spec(spec)
spec.loader.exec_module(labels)
print(json.dumps([labels.model_display_name('atum-managed', model, model) for model in sys.argv[2:]]))
assert labels.model_display_name('other', 'nguyet-thuc', 'Other model') == 'Other model'
assert labels.model_display_name('atum-managed', 'future', 'Future model') == 'Future model'
` , resolve(__dirname, '../../../acp_adapter/model_labels.py'), ...MATRIX_MODEL_LINEUP.flatMap(row => row.id ? [row.id] : [])], { encoding: 'utf8' })

  expect(JSON.parse(output)).toEqual(MATRIX_MODEL_LINEUP.flatMap(row => row.id ? [matrixModelName(row.id)] : []))
})
