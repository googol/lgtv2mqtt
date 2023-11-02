import { Agent } from 'node:https'
import fetch from 'node-fetch'
import type { ClientKeyStorage } from './lgtv2'

export class VaultTokenStorage implements ClientKeyStorage {
  private readonly vaultToken: string
  private readonly secretUrl: URL
  private readonly httpsAgent: Agent

  constructor(
    vaultAddress: URL,
    vaultCaCert: string,
    vaultToken: string,
    kvMount: string,
    secretPath: string,
  ) {
    this.vaultToken = vaultToken
    this.secretUrl = new URL(`/v1/${kvMount}/data/${secretPath}`, vaultAddress)

    this.httpsAgent = new Agent({
      keepAlive: true,
      ca: vaultCaCert,
    })
  }

  public async readClientKey(): Promise<string | undefined> {
    const response = await fetch(this.secretUrl, {
      headers: {
        'X-Vault-Token': this.vaultToken,
      },
      agent: this.httpsAgent,
    })

    if (response.status === 404) {
      return undefined
    } else if (!response.ok) {
      throw new Error('Failed to read from Vault', {
        cause: { status: response.status, body: await response.text() },
      })
    }

    const responseBody = (await response.json()) as {
      token: string | undefined
    }

    return responseBody.token
  }

  public async saveClientKey(token: string): Promise<void> {
    const response = await fetch(this.secretUrl, {
      method: 'POST',
      body: JSON.stringify({
        data: {
          token,
        },
      }),
      headers: {
        'X-Vault-Token': this.vaultToken,
      },
      agent: this.httpsAgent,
    })

    if (!response.ok) {
      throw new Error('Failed to write to Vault', {
        cause: { status: response.status, body: await response.text() },
      })
    }
  }
}
