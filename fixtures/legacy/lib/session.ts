import { cookies } from 'next/headers'

export async function readTheme(): Promise<string> {
  const store = await cookies()
  return store.get('theme')?.value ?? 'light'
}

// Sits in the same module as `readTheme` and reads nothing request-bound. A
// route that imports only this must not inherit the dynamic API above it -
// which is what per-export narrowing is for.
export function staticGreeting(): string {
  return 'hello'
}
