import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, expect, it } from 'vitest'

import { convertOffice } from './work-office-proof.test-support'

const python = process.env.WORK_OFFICE_PYTHON
const soffice = process.env.WORK_OFFICE_SOFFICE
const scripts = fileURLToPath(new URL('../../scripts/', import.meta.url))
const fixture = path.join(scripts, 'fixtures', 'work-office-fixture.py')
const roots: string[] = []
const dryRun = it.skipIf(!python || !soffice)

afterEach(() => {
  for (const root of roots.splice(0)) {rmSync(root, { recursive: true, force: true })}
})

function workspace(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'work-office-'))
  roots.push(root)

  return root
}

function run(script: string, ...args: string[]) {
  return execFileSync(python!, ['-I', '-B', script, ...args], { encoding: 'utf8', timeout: 45_000 })
}

function rejects(script: string, message: string, ...args: string[]) {
  const result = spawnSync(python!, ['-I', '-B', script, ...args], { encoding: 'utf8', timeout: 45_000 })
  expect(result.status, result.error?.message).toBe(1)
  expect(result.stderr).toContain(message)
}

dryRun('S4 recalculates a two-sheet CSV budget, preserves formulas and charts, and revises a copy', () => {
  const root = workspace()
  const source = path.join(root, 'Budget.xlsx')
  const revised = path.join(root, 'Budget revised.xlsx')
  const totals = path.join(root, 'totals.json')
  const validator = path.join(scripts, 'validate-xlsx.py')
  const calcFilter = 'xlsx:Calc MS Excel 2007 XML'

  run(fixture, 'budget', source, '--source', path.join(scripts, 'fixtures', 'work-budget.csv'))
  const original = readFileSync(source)
  const proof = convertOffice(soffice!, root, source, calcFilter)
  writeFileSync(totals, JSON.stringify({ Summary: { B2: 6000, B3: 5750, B4: 250 } }))
  run(validator, source, proof, totals)

  run('-c', `from openpyxl import load_workbook
import sys
book = load_workbook(sys.argv[1])
assert book.sheetnames == ["Budget", "Summary"]
assert book["Budget"].tables["BudgetInputs"].ref == "A1:C4"
`, source)

  run(fixture, 'edit-budget', revised, '--source', source, '--change', 'input')
  const revisedProof = convertOffice(soffice!, root, revised, calcFilter)
  rejects(validator, 'Unexpected recalculated result in Summary!B2', revised, revisedProof, totals)
  writeFileSync(totals, JSON.stringify({ Summary: { B2: 6200, B3: 5750, B4: 450 } }))
  run(validator, revised, revisedProof, totals)

  for (const [change, message] of [
    ['formula', 'Formula tree changed on Summary'],
    ['chart', 'Chart structure changed on Summary']
  ] as const) {
    const damaged = path.join(root, `${change}.xlsx`)
    run(fixture, 'edit-budget', damaged, '--source', source, '--change', change)
    rejects(validator, message, damaged, proof, totals)
  }

  expect(readFileSync(source)).toEqual(original)
}, 105_000)

dryRun('S5 renders five editable template slides and revises only the second slide', () => {
  const root = workspace()
  const template = path.join(scripts, 'fixtures', 'work-budget-template.pptx')
  const content = path.join(scripts, 'fixtures', 'work-deck.json')
  const source = path.join(root, 'Quarterly.pptx')
  const revised = path.join(root, 'Quarterly revised.pptx')
  const validator = path.join(scripts, 'validate-pptx.py')

  run(fixture, 'deck', source, '--source', template, '--content', content)
  const original = readFileSync(source)
  const proof = convertOffice(soffice!, root, source, 'pdf')
  run(validator, source, template, proof, content)

  const revisedContent = path.join(root, 'revised.json')
  const slides: { text: string[] }[] = JSON.parse(readFileSync(content, 'utf8'))
  slides[1]!.text[1] = 'Advance orders kept staffing below plan.'
  writeFileSync(revisedContent, JSON.stringify(slides))
  run(fixture, 'edit-deck', revised, '--source', source, '--change', 'revise')
  const revisedProof = convertOffice(soffice!, root, revised, 'pdf')
  run(validator, revised, template, revisedProof, revisedContent)
  rejects(validator, 'missing from or clipped in the proof', revised, template, proof, revisedContent)

  for (const [change, message] of [
    ['contrast', 'Text contrast is below 4.5:1'],
    ['bounds', 'A shape extends outside the canvas'],
    ['notes', 'Speaker notes differ'],
    ['master', 'Slide does not use the supplied master']
  ] as const) {
    const damaged = path.join(root, `${change}.pptx`)
    run(fixture, 'edit-deck', damaged, '--source', source, '--change', change)
    rejects(validator, message, damaged, template, proof, content)
  }

  expect(readFileSync(source)).toEqual(original)
}, 105_000)
