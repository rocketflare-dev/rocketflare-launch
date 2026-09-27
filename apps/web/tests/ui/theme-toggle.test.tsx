import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import ThemeToggle from '@/ui/components/ThemeToggle'

describe('ThemeToggle', () => {
  it('defaults to launch-light and toggles to launch-dark, persisting to localStorage', () => {
    render(<ThemeToggle />)

    expect(document.documentElement.getAttribute('data-theme')).toBe('launch-light')

    fireEvent.click(screen.getByRole('button'))

    expect(document.documentElement.getAttribute('data-theme')).toBe('launch-dark')
    expect(localStorage.getItem('theme')).toBe('launch-dark')

    fireEvent.click(screen.getByRole('button'))

    expect(document.documentElement.getAttribute('data-theme')).toBe('launch-light')
    expect(localStorage.getItem('theme')).toBe('launch-light')
  })

  it('restores a saved theme from localStorage on mount', () => {
    localStorage.setItem('theme', 'launch-dark')
    render(<ThemeToggle />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('launch-dark')
  })

  it('ignores an unknown stored theme instead of desyncing from the DOM', () => {
    localStorage.setItem('theme', 'some-old-theme')
    render(<ThemeToggle />)
    expect(document.documentElement.getAttribute('data-theme')).toBe('launch-light')
    expect(localStorage.getItem('theme')).toBe('launch-light')
  })
})
