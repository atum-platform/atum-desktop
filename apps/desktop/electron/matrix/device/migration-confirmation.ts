import { type MigrationChoice, migrationChoicePrompt, migrationReportConfirmation, type MigrationReportModel } from './migration-report'

export interface MigrationDialog {
  message: string
  detail: string
  buttons: string[]
  defaultId: number
  cancelId: number
}

/** Native, owner-initiated review. The complete report precedes every decision. Custom choices
 * are explicit for each path; cancellation at any step sends no choice to the controller. */
export async function confirmMigrationReport(locale: string | undefined, model: MigrationReportModel,
  show: (dialog: MigrationDialog) => Promise<number>): Promise<MigrationChoice | null> {
  const copy = migrationReportConfirmation(locale, model)

  const answer = await show({ message: copy.title, detail: copy.detail,
    buttons: [copy.confirm, copy.customize, copy.cancel], defaultId: 2, cancelId: 2 })

  if (answer === 0) {return model.choices.defaultChoice}

  if (answer !== 1) {return null}
  const choice = { drop: [] as string[], takeOther: [] as string[] }

  for (const kind of ['takeOther', 'drop'] as const) {
    for (const file of model.choices[kind]) {
      const prompt = migrationChoicePrompt(locale, kind, file)

      const selected = await show({ message: prompt.title, detail: prompt.detail,
        buttons: [prompt.accept, prompt.keep, prompt.cancel], defaultId: 1, cancelId: 2 })

      if (selected === 2 || selected < 0 || selected > 2) {return null}

      if (selected === 0) {choice[kind].push(file)}
    }
  }

  return choice
}
