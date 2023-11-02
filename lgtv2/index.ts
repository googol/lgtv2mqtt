/**
 *      Lgtv2 - Simple Node.js module to remote control LG WebOS smart TVs
 *
 *      MIT (c) Sebastian Raff <hq@ccu.io> (https://github.com/hobbyquaker)
 *      this is a fork of https://github.com/msloth/lgtv.js, heavily modified and rewritten to suite my needs.
 *
 */

import EventEmitter from 'node:events'
import util from 'node:util'
import { client as WebSocketClient } from 'websocket'
import { pairing } from './pairing'
import type {
  IClientConfig,
  connection as WebSocketConnection,
} from 'websocket'

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

export type LGTVConstructor = {
  (config: Partial<LGTVConfig>): LGTV_
  new (config: Partial<LGTVConfig>): LGTV_
}

type LGTVCallback = (error: unknown, payload?: ParsedMessage['payload']) => void

export type LGTV_ = {
  clientKeyStorage: ClientKeyStorage
  connect: (url: string) => void
  connection: boolean
  register: () => void
  request: (uri: string, payload: unknown, cb: LGTVCallback | undefined) => void
  subscribe: (
    uri: string,
    payload: unknown,
    cb: LGTVCallback | undefined,
  ) => void
  send: (
    type: string,
    uri: string | undefined,
    payload: unknown,
    cb: LGTVCallback | undefined,
  ) => void
  getSocket: (
    url: string,
    cb: (err: unknown, socket?: SpecializedSocket) => void,
  ) => void
  disconnect: () => void
} & EventEmitter

type ParsedMessage = {
  id: string
  payload: unknown
}

const defaultUrl = 'ws://lgwebostv:3000'

// @ts-expect-error -- legacy code
export const LGTV_: LGTVConstructor = function (
  this: LGTV_,
  config: Partial<LGTVConfig> = {},
): LGTV_ {
  if (!(this instanceof LGTV_)) {
    return new LGTV_(config)
  }
  // eslint-disable-next-line @typescript-eslint/no-this-alias -- legacy
  const that = this

  config.url = config.url ?? defaultUrl
  config.timeout = config.timeout ?? 15000
  config.reconnect =
    typeof config.reconnect === 'undefined' ? 5000 : config.reconnect
  config.wsconfig = config.wsconfig ?? {}
  if (config.clientKeyStorage === undefined) {
    throw new Error('No client key storage defined')
  } else {
    that.clientKeyStorage = config.clientKeyStorage
  }

  const client = new WebSocketClient(config.wsconfig)
  let connection: undefined | WebSocketConnection
  let isPaired = false
  let autoReconnect = Boolean(config.reconnect)

  const specializedSockets: Record<string, SpecializedSocket> = {}

  const callbacks: Record<
    string,
    (err: unknown, payload: ParsedMessage['payload']) => void
  > = {}
  let cidCount = 0
  const cidPrefix = `0000000${Math.floor(Math.random() * 0xffffffff).toString(
    16,
  )}`.slice(-8)

  function getCid() {
    const cidNum = cidCount
    cidCount += 1
    const postfix = `000${cidNum.toString(16)}`.slice(-4)
    return `${cidPrefix}${postfix}}`
  }

  let lastError: unknown

  client.on('connectFailed', (error) => {
    if (lastError !== error.toString()) {
      that.emit('error', error)
    }
    lastError = error.toString()

    if (config.reconnect !== undefined) {
      setTimeout(() => {
        if (autoReconnect) {
          // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy
          that.connect(config.url!)
        }
      }, config.reconnect)
    }
  })

  client.on('connect', (conn) => {
    connection = conn

    connection.on('error', (error: unknown) => {
      that.emit('error', error)
    })

    connection.on('close', (e: unknown) => {
      connection = undefined

      that.emit('close', e)
      that.connection = false
      if (config.reconnect !== undefined && config.reconnect !== 0) {
        setTimeout(() => {
          if (autoReconnect) {
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- legacy
            that.connect(config.url!)
          }
        }, config.reconnect)
      }
    })

    connection.on('message', (message) => {
      that.emit('message', message)
      let parsedMessage: ParsedMessage | undefined
      if (message.type === 'utf8') {
        if (message.utf8Data) {
          try {
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment -- legacy
            parsedMessage = JSON.parse(message.utf8Data)
          } catch (err) {
            that.emit(
              'error',
              new Error(`JSON parse error ${message.utf8Data}`, { cause: err }),
            )
          }
        }
        if (parsedMessage && callbacks[parsedMessage.id] !== undefined) {
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
          callbacks[parsedMessage.id]?.(null, parsedMessage.payload)
        }
      } else {
        that.emit(
          'error',
          new Error(`received non utf8 message ${message.toString()}`),
        )
      }
    })

    isPaired = false

    that.connection = false

    that.register()
  })

  this.register = function () {
    const clientKey = 'client-key'
    that.clientKeyStorage
      .readClientKey()
      .then((clientKeyValue) => {
        pairing[clientKey] = clientKeyValue

        that.send(
          'register',
          undefined,
          pairing,
          (err: unknown, res: unknown) => {
            if (
              err === undefined &&
              res !== undefined &&
              res !== null &&
              typeof res === 'object' &&
              'client-key' in res
            ) {
              const responseClientKey = res[clientKey]
              if (typeof responseClientKey === 'string') {
                that.emit('connect')
                that.connection = true
                that.clientKeyStorage
                  .saveClientKey(responseClientKey)
                  .catch((error) => {
                    if (error !== undefined) {
                      that.emit('error', err)
                    }
                  })
                isPaired = true
              } else {
                that.emit('prompt')
              }
            } else {
              that.emit('error', err)
            }
          },
        )
      })
      .catch((err) => that.emit('error', err))
  }

  this.request = function (uri, payload, cb) {
    this.send('request', uri, payload, cb)
  }

  this.subscribe = function (uri, payload, cb) {
    this.send('subscribe', uri, payload, cb)
  }

  this.send = (type, uri, payload, cb) => {
    const cid = getCid()

    const json = JSON.stringify({
      id: cid,
      type,
      uri,
      payload,
    })

    if (typeof cb === 'function') {
      switch (type) {
        case 'request':
          callbacks[cid] = function (err, res) {
            // Remove callback reference
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- legacy
            delete callbacks[cid]
            cb(err, res)
          }

          // Set callback timeout
          setTimeout(() => {
            if (callbacks[cid]) {
              cb(new Error('timeout'))
            }
            // Remove callback reference
            // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- legacy
            delete callbacks[cid]
          }, config.timeout)
          break

        case 'subscribe':
          callbacks[cid] = cb
          break

        case 'register':
          callbacks[cid] = cb
          break
        default:
          throw new Error('unknown type')
      }
    }
    connection?.send(json)
  }

  this.getSocket = (url, cb) => {
    const x = specializedSockets[url]
    if (x !== undefined) {
      cb(null, x)
      return
    }

    that.request(url, undefined, (err, data) => {
      if (err !== undefined) {
        cb(err)
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
        cb(new TypeError('Data was undefined'))
        return
      }

      const special = new WebSocketClient()
      special
        .on('connect', (conn) => {
          conn
            .on('error', (error) => {
              that.emit('error', error)
            })
            .on('close', () => {
              // eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- legacy
              delete specializedSockets[url]
            })

          specializedSockets[url] = new SpecializedSocket(conn)
          cb(null, specializedSockets[url])
        })
        .on('connectFailed', (error) => {
          that.emit('error', error)
        })

      special.connect(data.socketPath)
    })
  }

  /**
   *      Connect to TV using a websocket url (eg "ws://192.168.0.100:3000")
   *
   */
  this.connect = function (host) {
    autoReconnect = Boolean(config.reconnect)

    if (connection?.connected === true && !isPaired) {
      that.register()
    } else if (connection?.connected !== true) {
      that.emit('connecting', host)
      connection = undefined
      client.connect(host)
    }
  }

  this.disconnect = function () {
    if (connection !== undefined) {
      connection.close()
    }
    autoReconnect = false

    for (const socket of Object.values(specializedSockets)) {
      socket.close()
    }
  }

  setTimeout(() => {
    that.connect(config.url ?? defaultUrl)
  }, 0)

  return this
}

util.inherits(LGTV_, EventEmitter)
