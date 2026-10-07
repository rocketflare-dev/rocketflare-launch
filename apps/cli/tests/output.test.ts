import { stripVTControlCharacters } from 'node:util'
import chalk from 'chalk'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renderTable, visibleWidth } from '../src/utils/output'

describe('renderTable', () => {
  let level: typeof chalk.level
  beforeAll(() => {
    level = chalk.level
    chalk.level = 3
  })
  afterAll(() => {
    chalk.level = level
  })

  it('lines columns up by what the terminal shows, not by escape codes', () => {
    const table = renderTable(
      [
        { name: 'default', active: true, url: 'https://a.example' },
        { name: 'launch-rocketflare-dev', active: false, url: 'https://b.example' },
      ],
      [
        { header: 'NAME', value: r => (r.active ? chalk.bold(`${r.name} (active)`) : r.name) },
        { header: 'URL', value: r => r.url },
      ]
    )
    const lines = table.split('\n').map(line => stripVTControlCharacters(line))
    const urlColumn = lines.map(line => line.indexOf('https://'))
    expect(urlColumn[1]).toBe(urlColumn[2])
    expect(lines[0]?.indexOf('URL')).toBe(urlColumn[1])
  })

  it('measures a coloured string by its visible characters', () => {
    expect(visibleWidth(chalk.bold.red('abc'))).toBe(3)
  })
})
