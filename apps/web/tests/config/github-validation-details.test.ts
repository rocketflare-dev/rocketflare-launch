import { describe, expect, it } from 'vitest'
import { validationDetails } from '@/api/services/launch/github-app'

describe('validationDetails (a 422 says WHY)', () => {
  it('prefers each entry’s message, else resource.field: code', () => {
    expect(
      validationDetails([
        { resource: 'PullRequest', code: 'custom', message: 'No commits between main and x' },
        { resource: 'PullRequest', field: 'head', code: 'invalid' },
      ])
    ).toBe('No commits between main and x; PullRequest.head: invalid')
  })

  it('is null for anything that is not a list of errors', () => {
    expect(validationDetails(undefined)).toBeNull()
    expect(validationDetails([])).toBeNull()
    expect(validationDetails('nope')).toBeNull()
  })

  it('is bounded', () => {
    expect(validationDetails(['x'.repeat(1000)])?.length).toBe(300)
  })
})
