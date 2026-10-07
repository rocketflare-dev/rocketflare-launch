import { useCallback, useEffect, useRef, useState } from 'react'

/** Fired on `window` (detail: the key) when one instance sets a preference, so the others re-read. */
const PREFERENCE_CHANGED = 'launch:preference-changed'
const identity = (v: string) => v

/**
 * A per-user UI preference persisted in localStorage (collapsed nav, table density, the coding
 * agent a new session starts with…). Server-derived state never belongs here — that is the query
 * cache's job. Two components reading the same key stay in step: a set announces itself, and
 * another tab's write arrives as a `storage` event.
 */
export function useLocalStoragePreference<T>(
  key: string,
  defaultValue: T,
  serialize: (value: T) => string = String as unknown as (value: T) => string,
  deserialize: (value: string) => T = identity as unknown as (value: string) => T
): [T, (value: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const saved = localStorage.getItem(key)
      return saved === null ? defaultValue : deserialize(saved)
    } catch {
      return defaultValue
    }
  })
  /** Set by THIS instance since the last write: announce the write to the others. */
  const announce = useRef(false)

  useEffect(() => {
    try {
      localStorage.setItem(key, serialize(value))
    } catch {
      // Quota exceeded / privacy mode — the in-memory value still works
    }
    if (announce.current) {
      announce.current = false
      window.dispatchEvent(new CustomEvent(PREFERENCE_CHANGED, { detail: key }))
    }
  }, [key, value, serialize])

  useEffect(() => {
    const reread = () => {
      try {
        const saved = localStorage.getItem(key)
        if (saved !== null && saved !== serialize(value)) setValue(deserialize(saved))
      } catch {
        // Unreadable storage: keep the in-memory value
      }
    }
    const onChanged = (event: Event) => {
      if ((event as CustomEvent<string>).detail === key) reread()
    }
    const onStorage = (event: StorageEvent) => {
      if (event.key === key) reread()
    }
    window.addEventListener(PREFERENCE_CHANGED, onChanged)
    window.addEventListener('storage', onStorage)
    return () => {
      window.removeEventListener(PREFERENCE_CHANGED, onChanged)
      window.removeEventListener('storage', onStorage)
    }
  }, [key, value, serialize, deserialize])

  const set = useCallback((next: T | ((prev: T) => T)) => {
    announce.current = true
    setValue(next)
  }, [])

  return [value, set]
}

/** `'true'`/`'false'` string round-trip. */
export function useBooleanPreference(
  key: string,
  defaultValue: boolean
): [boolean, (value: boolean | ((prev: boolean) => boolean)) => void] {
  const serialize = useCallback((v: boolean) => String(v), [])
  const deserialize = useCallback((v: string) => v === 'true', [])
  return useLocalStoragePreference<boolean>(key, defaultValue, serialize, deserialize)
}

/** Type-safe string-enum preference. */
export function useStringPreference<T extends string>(
  key: string,
  defaultValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  const serialize = useCallback((v: T) => v, [])
  const deserialize = useCallback((v: string) => v as T, [])
  return useLocalStoragePreference<T>(key, defaultValue, serialize, deserialize)
}

/** Several related settings as one JSON object. */
export function useStoredSettings<T extends Record<string, unknown>>(
  key: string,
  defaultValue: T
): [T, (value: T | ((prev: T) => T)) => void] {
  return useLocalStoragePreference<T>(key, defaultValue, JSON.stringify, JSON.parse)
}
