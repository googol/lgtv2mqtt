/**
 *      Lgtv2 - Simple Node.js module to remote control LG WebOS smart TVs
 *
 *      MIT (c) Sebastian Raff <hq@ccu.io> (https://github.com/hobbyquaker)
 *      this is a fork of https://github.com/msloth/lgtv.js, heavily modified and rewritten to suite my needs.
 *
 */

import EventEmitter from 'node:events'
import { client as WebSocketClient } from 'websocket'
import { pairing } from './pairing'
import type {
  IClientConfig,
  connection as WebSocketConnection,
} from 'websocket'

type ParsedMessage = {
  id: string
  payload: unknown
}

const defaultUrl = 'ws://lgwebostv:3000'

class SpecializedSocket {
  private readonly ws: WebSocketConnection

  constructor(ws: WebSocketConnection) {
    this.ws = ws
  }

  send(type: string, payload: Record<string, string> = {}) {
    // The message should be key:value pairs, one per line,
    // with an extra blank line to terminate.
    const message = Object.entries(payload)
      .reduce(
        (acc, [key, value]) => acc.concat([[key, value].join(':')]),
        [['type:', type].join(';')],
      )
      .concat('\n')
      .join('\n')

    this.ws.send(message)
  }

  close() {
    this.ws.close()
  }
}

export type ClientKeyStorage = {
  readClientKey: () => Promise<string | undefined>
  saveClientKey: (clientKey: string) => Promise<void>
}

export type LGTVConfig = {
  clientKeyStorage: ClientKeyStorage
  url: string
  timeout: number
  reconnect: number
  wsconfig: IClientConfig
}

type LGTVCallback = (error: unknown, payload?: ParsedMessage['payload']) => void

export class LGTV extends EventEmitter {
  private readonly callbacks = new Map<
    string,
    (err: unknown, payload: ParsedMessage['payload']) => void
  >()
  private readonly cidPrefix = `0000000${Math.floor(
    Math.random() * 0xffffffff,
  ).toString(16)}`.slice(-8)
  private readonly client: WebSocketClient
  private readonly clientKeyStorage: ClientKeyStorage
  private readonly initialAutoReconnect: boolean
  private readonly reconnect: number
  private readonly specializedSockets = new Map<string, SpecializedSocket>()
  private readonly timeout: number
  private readonly url: string
  private readonly wsconfig: IClientConfig
  private autoReconnect: boolean
  private cidCount = 0
  private connection: undefined | WebSocketConnection
  private isPaired = false
  private lastError: string | undefined

  constructor(config: Readonly<Partial<LGTVConfig>>) {
    super()

    if (config.clientKeyStorage === undefined) {
      throw new Error('Client key store not defined')
    } else {
      this.clientKeyStorage = config.clientKeyStorage
    }

    this.url = config.url ?? defaultUrl
    this.timeout = config.timeout ?? 15000
    this.reconnect = config.reconnect ?? 5000
    this.initialAutoReconnect = config.reconnect !== undefined
    this.autoReconnect = this.initialAutoReconnect
    this.wsconfig = config.wsconfig ?? {}

    this.client = new WebSocketClient(this.wsconfig)

    this.client.on('connectFailed', (error) => {
      this.emitErrorIfNotSameAsPrevious(error)

      if (this.autoReconnect) {
        setTimeout(() => {
          if (this.autoReconnect) {
            this.connect()
          }
        }, config.reconnect)
      }
    })

    this.client.on('connect', (connection) => {
      connection.on('error', (error: unknown) => {
        this.emit('error', error)
      })

      connection.on('close', (e: unknown) => {
        this.connection = undefined

        this.emit('close', e)
        if (this.autoReconnect && this.reconnect !== 0) {
          setTimeout(() => {
            if (this.autoReconnect) {
              this.connect()
            }
          }, this.reconnect)
        }
      })

      connection.on('message', (message) => {
        this.emit('message', message)
        let parsedMessage: ParsedMessage | undefined
        if (message.type === 'utf8') {
          if (message.utf8Data) {
            try {
              // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- legacy
              parsedMessage = JSON.parse(message.utf8Data)
            } catch (err) {
              this.emit(
                'error',
                new Error(`JSON parse error ${message.utf8Data}`, {
                  cause: err,
                }),
              )
            }
          }
          if (parsedMessage && this.callbacks.has(parsedMessage.id)) {
            /* eslint-disable @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any -- legacy */
            const payload = parsedMessage as any
            if (payload.subscribed) {
              // Set changed array on first response to subscription
              if (typeof payload.muted !== 'undefined') {
                if (payload.changed !== undefined) {
                  payload.changed.push('muted')
                } else {
                  payload.changed = ['muted']
                }
              }
              if (typeof payload.volume !== 'undefined') {
                if (payload.changed) {
                  payload.changed.push('volume')
                } else {
                  payload.changed = ['volume']
                }
              }
            }
            /* eslint-enable @typescript-eslint/strict-boolean-expressions, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-explicit-any */
            this.callbacks.get(parsedMessage.id)?.(null, parsedMessage.payload)
          }
        } else {
          this.emit(
            'error',
            new Error(`received non utf8 message ${message.toString()}`),
          )
        }
      })

      this.isPaired = false

      this.register()
    })
  }

  private emitErrorIfNotSameAsPrevious(error: { toString: () => string }) {
    const thisError = error.toString()
    if (this.lastError !== thisError) {
      this.emit('error', error)
    }
    this.lastError = thisError
  }

  public register(): void {
    const clientKey = 'client-key'
    this.clientKeyStorage
      .readClientKey()
      .then((clientKeyValue) => {
        pairing[clientKey] = clientKeyValue

        this.send(
          'register',
          undefined,
          pairing,
          (err: unknown, res: unknown) => {
            if (
              err === undefined &&
              res !== undefined &&
              res !== null &&
              typeof res === 'object' &&
              clientKey in res
            ) {
              const responseClientKey = res[clientKey]
              if (typeof responseClientKey === 'string') {
                this.emit('connect')
                this.clientKeyStorage
                  .saveClientKey(responseClientKey)
                  .catch((error) => {
                    if (error !== undefined) {
                      this.emit('error', err)
                    }
                  })
                this.isPaired = true
              } else {
                this.emit('prompt')
              }
            } else {
              this.emit('error', err)
            }
          },
        )
      })
      .catch((err) => this.emit('error', err))
  }

  public request(
    uri: string,
    payload: unknown,
    cb: LGTVCallback | undefined,
  ): void {
    this.send('request', uri, payload, cb)
  }

  public subscribe(
    uri: string,
    payload: unknown,
    cb: LGTVCallback | undefined,
  ): void {
    this.send('subscribe', uri, payload, cb)
  }

  private getCid(): string {
    const cidNum = this.cidCount
    this.cidCount += 1
    const postfix = `000${cidNum.toString(16)}`.slice(-4)
    return `${this.cidPrefix}${postfix}}`
  }

  private send(
    type: string,
    uri: string | undefined,
    payload: unknown,
    cb: LGTVCallback | undefined,
  ) {
    const cid = this.getCid()

    const json = JSON.stringify({
      id: cid,
      type,
      uri,
      payload,
    })

    if (typeof cb === 'function') {
      switch (type) {
        case 'request':
          this.callbacks.set(cid, (err, res) => {
            // Remove callback reference
            this.callbacks.delete(cid)
            cb(err, res)
          })

          // Set callback timeout
          setTimeout(() => {
            if (this.callbacks.has(cid)) {
              cb(new Error('timeout'))
            }
            // Remove callback reference
            this.callbacks.delete(cid)
          }, this.timeout)
          break

        case 'subscribe':
          this.callbacks.set(cid, cb)
          break

        case 'register':
          this.callbacks.set(cid, cb)
          break
        default:
          throw new Error('unknown type')
      }
    }
    this.connection?.send(json)
  }

  public getSocket(
    url: string,
    cb: (err: unknown, socket: SpecializedSocket | undefined) => void,
  ): void {
    const x = this.specializedSockets.get(url)
    if (x !== undefined) {
      cb(null, x)
      return
    }

    this.request(url, undefined, (err, data) => {
      if (err !== undefined) {
        cb(err, undefined)
        return
      }

      if (
        !(
          data !== undefined &&
          data !== null &&
          typeof data === 'object' &&
          'socketPath' in data &&
          typeof data.socketPath === 'string'
        )
      ) {
        cb(new TypeError('Data was undefined'), undefined)
        return
      }

      const special = new WebSocketClient()
      special
        .on('connect', (conn) => {
          conn
            .on('error', (error) => {
              this.emit('error', error)
            })
            .on('close', () => {
              this.specializedSockets.delete(url)
            })

          const specializedSocket = new SpecializedSocket(conn)
          this.specializedSockets.set(url, specializedSocket)
          cb(null, specializedSocket)
        })
        .on('connectFailed', (error) => {
          this.emit('error', error)
        })

      special.connect(data.socketPath)
    })
  }

  public connect(): void {
    this.autoReconnect = this.initialAutoReconnect
    if (this.connection?.connected !== true) {
      this.emit('connecting', this.url)
      this.connection = undefined
      this.client.connect(this.url)
    } else if (!this.isPaired) {
      this.register()
    }
  }

  public disconnect(): void {
    this.autoReconnect = false

    const { connection } = this
    const sockets = Array.from(this.specializedSockets.values())

    this.connection = undefined
    this.specializedSockets.clear()

    for (const socket of sockets) {
      socket.close()
    }

    if (connection !== undefined) {
      connection.close()
    }
  }
}
