import { MembraneClient } from '@membranehq/sdk'
import jwt from 'jsonwebtoken'
import { env } from './env'

export const membrane = new MembraneClient({
  fetchToken: async () =>
    jwt.sign(
      { workspaceKey: env.MEMBRANE_WORKSPACE_KEY, id: env.MEMBRANE_CUSTOMER_ID },
      env.MEMBRANE_WORKSPACE_SECRET,
      { expiresIn: 7200, algorithm: 'HS512' },
    ),
})
