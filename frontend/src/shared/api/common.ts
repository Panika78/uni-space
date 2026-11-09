import type { components } from './schema'

export type Page<T> = Omit<components['schemas']['Page'], 'items'> & { items: T[] }
