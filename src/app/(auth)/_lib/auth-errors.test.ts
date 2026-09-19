import { describe, expect, it } from 'vitest'

import {
  AUTH_ERROR_ALREADY_REGISTERED,
  AUTH_ERROR_EMAIL_NOT_CONFIRMED,
  AUTH_ERROR_EMAIL_RATE_LIMIT,
  AUTH_ERROR_GENERIC,
  AUTH_ERROR_INVALID_CREDENTIALS,
  AUTH_ERROR_NETWORK,
  AUTH_ERROR_TOO_MANY_REQUESTS,
  AUTH_ERROR_WEAK_PASSWORD,
  friendlyAuthError,
} from './auth-errors'

describe('friendlyAuthError', () => {
  it('prefers the stable error code', () => {
    expect(friendlyAuthError({ message: 'whatever', code: 'invalid_credentials' })).toBe(
      AUTH_ERROR_INVALID_CREDENTIALS,
    )
    expect(friendlyAuthError({ message: 'x', code: 'email_not_confirmed' })).toBe(
      AUTH_ERROR_EMAIL_NOT_CONFIRMED,
    )
    expect(friendlyAuthError({ message: 'x', code: 'user_already_exists' })).toBe(
      AUTH_ERROR_ALREADY_REGISTERED,
    )
  })

  it('falls back to the message for older GoTrue shapes', () => {
    expect(friendlyAuthError({ message: 'Invalid login credentials' })).toBe(
      AUTH_ERROR_INVALID_CREDENTIALS,
    )
    expect(friendlyAuthError({ message: 'Email not confirmed' })).toBe(
      AUTH_ERROR_EMAIL_NOT_CONFIRMED,
    )
    expect(friendlyAuthError({ message: 'User already registered' })).toBe(
      AUTH_ERROR_ALREADY_REGISTERED,
    )
    expect(friendlyAuthError({ message: 'Email rate limit exceeded' })).toBe(
      AUTH_ERROR_EMAIL_RATE_LIMIT,
    )
    expect(
      friendlyAuthError({ message: 'For security purposes, you can only request this after 42 seconds.' }),
    ).toBe(AUTH_ERROR_TOO_MANY_REQUESTS)
    expect(friendlyAuthError({ message: 'Password should be at least 6 characters.' })).toBe(
      AUTH_ERROR_WEAK_PASSWORD,
    )
    expect(friendlyAuthError({ message: 'Failed to fetch' })).toBe(AUTH_ERROR_NETWORK)
  })

  it('uses the HTTP status when nothing else matches', () => {
    expect(friendlyAuthError({ message: 'nope', status: 429 })).toBe(AUTH_ERROR_TOO_MANY_REQUESTS)
  })

  it('collapses unknown errors to the generic retry message', () => {
    expect(friendlyAuthError({ message: 'Database error saving new user' })).toBe(AUTH_ERROR_GENERIC)
    expect(friendlyAuthError(null)).toBe(AUTH_ERROR_GENERIC)
  })
})
