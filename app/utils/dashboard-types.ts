export interface DiffLine {
  readonly key: string
  readonly depth: number
  readonly text: string
  readonly value?: string
  readonly structural: boolean
}
