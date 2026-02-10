import { LinearSdk, parseLinearError } from '@linear/sdk'
import type { LinearRequest } from '@linear/sdk'
import { env } from './env'
import { membrane } from './membrane'

async function graphqlRequest<T>(doc: string, variables?: Record<string, unknown>): Promise<T> {
  const { data, errors } = await membrane.connection(env.MEMBRANE_CONNECTION_SELECTOR).proxy.post('graphql', {
    query: doc,
    variables,
  })

  if (errors && errors.length) {
    throw parseLinearError(errors[0])
  }

  return data as T
}

export class LinearService extends LinearSdk {
  constructor() {
    super(graphqlRequest as LinearRequest)
  }

  /** Execute a raw GraphQL query through the Membrane proxy. */
  query<T = unknown>(doc: string, variables?: Record<string, unknown>): Promise<T> {
    return graphqlRequest<T>(doc, variables)
  }

  /** Download a file through the Membrane proxy (handles Linear auth automatically). */
  async download(url: string): Promise<Buffer> {
    const proxyPath = `/connections/${env.MEMBRANE_CONNECTION_SELECTOR}/proxy/${url}`
    const result = await (membrane as any).get(proxyPath, undefined, { responseType: 'arraybuffer' })
    return Buffer.isBuffer(result) ? result : Buffer.from(result)
  }
}

export const linear = new LinearService()
