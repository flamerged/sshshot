import enquirer from 'enquirer'

// enquirer's published .d.ts doesn't expose Select/Confirm/Input/MultiSelect
// on the default export (the runtime does). We narrow the type to the exact
// shape we use rather than `as any`, so misuse of the prompt API still
// produces a TypeScript error at the call site.

interface PromptInstance<T> {
  run(): Promise<T>
}

interface PromptOptions {
  name: string
  message: string
}

interface ConfirmOptions extends PromptOptions {
  format?: (v: boolean) => string
}

interface InputOptions extends PromptOptions {
  initial?: string
}

interface SelectOptions extends PromptOptions {
  choices: string[]
}

interface MultiSelectChoice {
  enabled?: boolean
}

interface MultiSelectOptions extends PromptOptions {
  choices: string[]
  initial?: string[]
  indicator?: (state: unknown, choice: MultiSelectChoice) => string
}

interface EnquirerExports {
  Confirm: new (opts: ConfirmOptions) => PromptInstance<boolean>
  Input: new (opts: InputOptions) => PromptInstance<string>
  Select: new (opts: SelectOptions) => PromptInstance<string>
  MultiSelect: new (opts: MultiSelectOptions) => PromptInstance<string[]>
}

const { Select, Confirm, Input, MultiSelect } = enquirer as unknown as EnquirerExports

// Suppress enquirer's readline error on Ctrl+C (Node.js 24+ issue).
// Scoped tighter than before by also requiring the error to originate from
// enquirer's call site, so an unrelated bug elsewhere in the process that
// happened to include "readline was closed" in its message wouldn't be
// silently swallowed.
process.on('uncaughtException', (err) => {
  const fromEnquirer = err.stack?.includes('enquirer') === true
  if (fromEnquirer && err.message?.includes('readline was closed')) {
    console.log('\nCancelled')
    process.exit(0)
  }
  throw err
})

function handleCancel(): never {
  console.log('\nCancelled')
  process.exit(0)
}

export async function promptConfirm(message: string): Promise<boolean> {
  try {
    const prompt = new Confirm({
      name: 'confirm',
      message,
      format: (v: boolean) => (v ? 'Y' : 'N')
    })
    return await prompt.run()
  } catch {
    handleCancel()
  }
}

export async function promptInput(message: string): Promise<string> {
  try {
    const prompt = new Input({ name: 'input', message })
    return await prompt.run()
  } catch {
    handleCancel()
  }
}

export async function promptSelect(message: string, choices: string[]): Promise<string> {
  try {
    const prompt = new Select({ name: 'select', message, choices })
    return await prompt.run()
  } catch {
    handleCancel()
  }
}

export async function promptMultiSelect(message: string, choices: string[]): Promise<string[]> {
  try {
    const prompt = new MultiSelect({
      name: 'multiselect',
      message,
      choices: choices,
      initial: choices,
      indicator(_state, choice) {
        return choice.enabled === true ? '●' : '○'
      }
    })
    return await prompt.run()
  } catch {
    handleCancel()
  }
}
