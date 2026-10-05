/**
 * `Combobox` — the editable combobox with a listbox popup: ARIA wiring (combobox → listbox,
 * active descendant, selected option), filtering by what is typed, the keyboard (ArrowDown/Up
 * wrapping, Alt+ArrowDown, Home/End, Enter, Escape, Tab), mouse picks, and free text that matches
 * no option.
 */
import { fireEvent, render, screen, within } from '@testing-library/react'
import { useState } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { Combobox } from '@/ui/components/Combobox'

const OPTIONS = [
  { value: '0.17.1', description: 'latest' },
  { value: '0.17.0' },
  { value: '0.16.3' },
  { value: '0.15.0' },
]

function Harness({
  onSelect = () => undefined,
  onOpenChange,
  onSubmit = () => undefined,
}: {
  onSelect?: (value: string) => void
  onOpenChange?: (open: boolean) => void
  onSubmit?: (value: string) => void
}) {
  const [value, setValue] = useState('')
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        onSubmit(value)
      }}
    >
      <label htmlFor="tag">Release tag</label>
      <Combobox
        id="tag"
        value={value}
        onChange={setValue}
        onSelect={onSelect}
        onOpenChange={onOpenChange}
        options={OPTIONS}
        emptyMessage="No matching tags"
      />
    </form>
  )
}

function setup(props: Parameters<typeof Harness>[0] = {}) {
  render(<Harness {...props} />)
  return screen.getByRole('combobox', { name: 'Release tag' })
}

const options = () => within(screen.getByRole('listbox')).getAllByRole('option')
const activeOption = (input: HTMLElement) => {
  const id = input.getAttribute('aria-activedescendant')
  return id ? document.getElementById(id) : null
}

describe('Combobox', () => {
  it('is a collapsed combobox wired to its listbox', () => {
    const input = setup()
    expect(input).toHaveAttribute('aria-autocomplete', 'list')
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).toHaveAttribute('aria-controls', 'tag-listbox')
    expect(input).not.toHaveAttribute('aria-activedescendant')
    expect(screen.queryByRole('listbox')).toBeNull()
  })

  it('opens on ArrowDown at the first option, and moves (wrapping) with ArrowDown / ArrowUp', () => {
    const onOpenChange = vi.fn()
    const input = setup({ onOpenChange })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(onOpenChange).toHaveBeenLastCalledWith(true)
    expect(screen.getByRole('listbox')).toHaveAttribute('id', 'tag-listbox')
    expect(options()).toHaveLength(4)
    expect(activeOption(input)).toBe(options()[0])
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
    expect(options()[1]).toHaveAttribute('aria-selected', 'false')

    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(activeOption(input)).toHaveTextContent('0.17.0')
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(activeOption(input)).toHaveTextContent('0.15.0') // wrapped to the end
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    expect(activeOption(input)).toHaveTextContent('0.17.1') // and back to the start
  })

  it('opens on ArrowUp at the last option; Alt+ArrowDown opens without highlighting', () => {
    const input = setup()
    fireEvent.keyDown(input, { key: 'ArrowUp' })
    expect(activeOption(input)).toHaveTextContent('0.15.0')
    fireEvent.keyDown(input, { key: 'Escape' })
    fireEvent.keyDown(input, { key: 'ArrowDown', altKey: true })
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(input).not.toHaveAttribute('aria-activedescendant')
  })

  it('jumps with Home and End while open', () => {
    const input = setup()
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'End' })
    expect(activeOption(input)).toHaveTextContent('0.15.0')
    fireEvent.keyDown(input, { key: 'Home' })
    expect(activeOption(input)).toHaveTextContent('0.17.1')
  })

  it('picks the highlighted option on Enter without submitting the form', () => {
    const onSelect = vi.fn()
    const onSubmit = vi.fn()
    const input = setup({ onSelect, onSubmit })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('0.17.0')
    expect(onSelect).toHaveBeenCalledWith('0.17.0')
    expect(onSubmit).not.toHaveBeenCalled()
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('filters by what is typed, case-insensitively, and says when nothing matches', () => {
    const input = setup()
    fireEvent.change(input, { target: { value: '0.17' } })
    expect(input).toHaveAttribute('aria-expanded', 'true')
    expect(options().map(o => o.textContent)).toEqual(['0.17.1latest', '0.17.0'])
    expect(input).not.toHaveAttribute('aria-activedescendant')
    fireEvent.change(input, { target: { value: '9.9' } })
    expect(screen.queryAllByRole('option')).toHaveLength(0)
    expect(screen.getByRole('status')).toHaveTextContent('No matching tags')
  })

  it('keeps free text that matches no option: Enter submits it', () => {
    const onSubmit = vi.fn()
    const input = setup({ onSubmit })
    fireEvent.change(input, { target: { value: '0.15.9' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(input).toHaveValue('0.15.9')
    fireEvent.submit(input.closest('form') as HTMLFormElement)
    expect(onSubmit).toHaveBeenCalledWith('0.15.9')
  })

  it('closes on Escape, then clears on a second Escape; Tab closes too', () => {
    const input = setup()
    fireEvent.change(input, { target: { value: '0.16' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveAttribute('aria-expanded', 'false')
    expect(input).toHaveValue('0.16')
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(input).toHaveValue('')
    fireEvent.keyDown(input, { key: 'ArrowDown' })
    fireEvent.keyDown(input, { key: 'Tab' })
    expect(input).toHaveAttribute('aria-expanded', 'false')
  })

  it('picks with the mouse, and shows every option again after a pick', () => {
    const onSelect = vi.fn()
    const input = setup({ onSelect })
    fireEvent.change(input, { target: { value: '0.16' } })
    fireEvent.mouseEnter(options()[0] as HTMLElement)
    expect(options()[0]).toHaveAttribute('aria-selected', 'true')
    fireEvent.click(options()[0] as HTMLElement)
    expect(input).toHaveValue('0.16.3')
    expect(onSelect).toHaveBeenCalledWith('0.16.3')
    expect(screen.queryByRole('listbox')).toBeNull()

    fireEvent.click(screen.getByRole('button', { name: 'Show options' }))
    expect(options()).toHaveLength(4)
  })
})
