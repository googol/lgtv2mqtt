import assert from 'node:assert'
import fs from 'node:fs/promises'
import * as wol from 'wol'
import { VaultTokenStorage } from './VaultTokenStorage'
import { isNullish } from './helpers/isNullish'
import * as mqtt_helpers from './homeautomation-js-lib/mqtt_helpers'
import { LGTV } from './lgtv2'

main().catch((e) => {
  console.error('Main crashed', e)
  process.exitCode = 1
})

async function main() {
  let tvOn = false
  let requestedTVOn: boolean | null = null
  let mqttConnected = false
  let tvConnected = false
  let lastError: unknown
  let foregroundApp: unknown = null

  const tvMAC = process.env.TV_MAC
  const tvIP = process.env.TV_IP

  assert.ok(tvIP)

  const mqttOptions = { retain: true, qos: 1 } as const
  const topic_prefix = process.env.TOPIC_PREFIX

  if (isNullish(topic_prefix)) {
    console.error('TOPIC_PREFIX not set, not starting')
    process.abort()
  }

  const vaultAddressString = process.env.VAULT_ADDR
  if (vaultAddressString === undefined) {
    console.error('VAULT_ADDR not set, not starting')
    process.abort()
  }
  const vaultAddress = new URL(vaultAddressString)

  const vaultToken = process.env.VAULT_TOKEN
  if (vaultToken === undefined) {
    console.error('VAULT_TOKEN not set, not starting')
    process.abort()
  }

  const vaultCaCertPath = process.env.VAULT_CACERT
  if (vaultCaCertPath === undefined) {
    console.error('VAULT_CACERT not set, not starting')
    process.abort()
  }

  const vaultCaCert = await fs.readFile(vaultCaCertPath, 'utf-8')

  const vaultTokenStorage = new VaultTokenStorage(
    vaultAddress,
    vaultCaCert,
    vaultToken,
    'kv',
    'lgtv',
  )

  console.info('lgtv2mqtt starting')

  const mqtt = mqtt_helpers.setupClient(
    () => {
      mqttConnected = true

      mqtt.publish(
        `${topic_prefix}/connected`,
        tvConnected ? '1' : '0',
        mqttOptions,
      )

      console.info('mqtt subscribe', `${topic_prefix}/set/#`)
      mqtt.subscribe(`${topic_prefix}/set/#`, { qos: 1 })
    },
    () => {
      if (mqttConnected) {
        mqttConnected = false
        console.error('mqtt disconnected')
      }
    },
  )

  const setTvPowerStatus = (status: boolean) => {
    tvOn = status
    mqtt.publish(
      `${topic_prefix}/tv_powered`,
      status ? '1' : '0',
      mqttOptions,
    )
  }

  const setTvConnected = (status: boolean) => {
    tvConnected = status

    mqtt.publish(
      `${topic_prefix}/connected`,
      status ? '1' : '0',
      mqttOptions,
    )

    setTvPowerStatus(false)
  }

  const powerOn =  function() {
    console.info(`power off`, { currentStatus: tvOn })
    if (tvMAC === undefined) {
      console.warn(`TV MAC not specified, not continuing`)
      return
    }

    // eslint-disable-next-line @typescript-eslint/no-floating-promises -- The typings are a bit wrong here, since we are using a callback, the promise shouldn't be interesting
    wol.wake(tvMAC, (err, res) => {
      if (err) {
        console.error(`Failed to wake up LGTV via WOL`, err)
        return
      }
      console.info(`WOL: ${String(res)}`)
      requestedTVOn = true
      if (foregroundApp === null) {
        console.info('lg > ssap://system/turnOff (to turn it on...)')
        lgtv.request('ssap://system/turnOff', undefined, undefined)
      }
    })
  }
  const powerOff = function () {
    console.info(`power off`, { currentStatus: tvOn })
    if (tvOn) {
      console.info('lg > ssap://system/turnOff')
      lgtv.request('ssap://system/turnOff', undefined, undefined)
      setTvPowerStatus(false)
      requestedTVOn = false
    }
  }

  const lgtv = new LGTV({
    url: `ws://${tvIP}:3000`,
    reconnect: 1000,
    clientKeyStorage: vaultTokenStorage,
  })

  mqtt.on('error', (err) => {
    console.error(`mqtt error: `, err)
  })

  mqtt.on('message', (inTopic, inPayload) => {
    let topic = inTopic
    const payload = inPayload.toString('utf8')
    console.info(`mqtt <${topic}:${payload}`)

    if (topic.startsWith('/')) {
      topic = topic.substring(1)
    }

    const parts = topic.split('/')

    // eslint-disable-next-line sonarjs/no-small-switch -- keeping this for now for the old code layout
    switch (parts[1]) {
      case 'set':
        // eslint-disable-next-line sonarjs/no-nested-switch -- keeping this for now for the old code layout
        switch (parts[2]) {
          case 'toast':
            lgtv.request(
              'ssap://system.notifications/createToast',
              {
                message: payload,
              },
              undefined,
            )
            break
          case 'volume':
            lgtv.request(
              'ssap://audio/setVolume',
              {
                volume: parseInt(payload, 10),
              },
              undefined,
            )
            break
          case 'mute':
            if (payload === 'true') {
              lgtv.request('ssap://audio/setMute', { mute: true }, undefined)
            }
            if (payload === 'false') {
              lgtv.request('ssap://audio/setMute', { mute: false }, undefined)
            }
            break

          case 'input':
            console.info('lg > ssap://tv/switchInput', { inputId: payload })
            lgtv.request(
              'ssap://tv/switchInput',
              { inputId: payload },
              undefined,
            )
            break

          case 'launch':
            lgtv.request(
              'ssap://system.launcher/launch',
              { id: payload },
              undefined,
            )
            break

          case 'powerOn':
            powerOn()

            break

          case 'powerOff':
            powerOff()
            break

          case 'button':
            /*
             * Buttons that are known to work:
             *    MUTE, RED, GREEN, YELLOW, BLUE, HOME, MENU, VOLUMEUP, VOLUMEDOWN,
             *    CC, BACK, UP, DOWN, LEFT, ENTER, DASH, 0-9, EXIT
             *
             * Probably also (but I don't have the facility to test them):
             *    CHANNELUP, CHANNELDOWN
             */
            sendPointerEvent('button', { name: payload.toUpperCase() })
            break

          default: {
            const inPayloadAsString = inPayload.toString()
            console.info(`lg > ssap://${inPayloadAsString}`)
            lgtv.request(`ssap://${inPayloadAsString}`, undefined, undefined)
          }
        }
        break
      default:
    }
  })

  lgtv.on('prompt', () => {
    console.info('authorization required')
  })

  function isVolumeUpdate(
    response: unknown,
  ): response is { changed: string[]; volume: number; muted: boolean } {
    return (
      response !== undefined &&
      typeof response === 'object' &&
      response !== null &&
      'changed' in response &&
      Array.isArray(response.changed) &&
      'volume' in response &&
      typeof response.volume === 'number' &&
      'muted' in response &&
      typeof response.muted === 'boolean'
    )
  }

  lgtv.on('connect', () => {
    setTvPowerStatus(true)
    let channelsSubscribed = false
    lastError = null
    console.info('tv connected, tvConnected = true')
    setTvConnected(true)

    lgtv.subscribe('ssap://audio/getVolume', undefined, (err, res) => {
      console.info('audio/getVolume', err, res)
      if (!isVolumeUpdate(res)) {
        console.error('Unexpected response from volume update', res)
        return
      }

      if (res.changed.includes('volume')) {
        mqtt.publish(
          `${topic_prefix}/status/volume`,
          String(res.volume),
          mqttOptions,
        )
      }
      if (res.changed.includes('muted')) {
        mqtt.publish(
          `${topic_prefix}/status/mute`,
          res.muted ? '1' : '0',
          mqttOptions,
        )
      }
    })

    function isAppInfoResponse(
      response: unknown,
    ): response is { appId: string } {
      return (
        response !== undefined &&
        typeof response === 'object' &&
        response !== null &&
        'appId' in response &&
        typeof response.appId === 'string'
      )
    }

    function isChannelInfoResponse(
      response: unknown,
    ): response is { channelNumber: string } {
      return (
        response !== undefined &&
        typeof response === 'object' &&
        response !== null &&
        'channelNumber' in response &&
        typeof response.channelNumber === 'string'
      )
    }

    lgtv.subscribe(
      'ssap://com.webos.applicationManager/getForegroundAppInfo',
      undefined,
      (err, res) => {
        console.info('getForegroundAppInfo', err, res)
        if (!isAppInfoResponse(res)) {
          console.error('Unexpected response from foreground app update', res)
          return
        }

        mqtt.publish(
          `${topic_prefix}/status/foregroundApp`,
          String(res.appId),
          mqttOptions,
        )

        if (!isNullish(res.appId) && res.appId.length > 0) {
          setTvPowerStatus(true)
          foregroundApp = res.appId
        } else {
          setTvPowerStatus(false)
          foregroundApp = null
        }

        if (res.appId === 'com.webos.app.livetv' && !channelsSubscribed) {
          channelsSubscribed = true
          setTimeout(() => {
            lgtv.subscribe(
              'ssap://tv/getCurrentChannel',
              undefined,
              (channelErr, channelRes) => {
                if (!isNullish(channelErr)) {
                  console.error(channelErr)
                  return
                }

                if (!isChannelInfoResponse(channelRes)) {
                  console.error(
                    'Unexpected response from channel switch',
                    channelRes,
                  )
                  return
                }
                const msg = {
                  val: channelRes.channelNumber,
                  lgtv: channelRes,
                }
                mqtt.publish(
                  `${topic_prefix}/status/currentChannel`,
                  JSON.stringify(msg),
                  mqttOptions,
                )
              },
            )
          }, 2500)
        }
      },
    )

    lgtv.subscribe('ssap://tv/getExternalInputList', undefined, (err, res) => {
      console.info('getExternalInputList', err, res)
    })

    if (requestedTVOn === false) {
      powerOff()
    }
  })

  lgtv.on('connecting', (host) => {
    console.info('tv trying to connect', host)
  })

  lgtv.on('close', () => {
    lastError = null
    setTvConnected(false)
  })

  lgtv.on('error', (err) => {
    const str = String(err)
    if (str !== lastError) {
      console.error(`tv error: ${str}`)
    }
    lastError = str
  })

  const sendPointerEvent = function (type: string, payload: { name: string }) {
    lgtv.getSocket(
      'ssap://com.webos.service.networkinput/getPointerInputSocket',
      (err, sock) => {
        if (isNullish(err) && !isNullish(sock)) {
          sock.send(type, payload)
        }
      },
    )
  }

  lgtv.connect()
}
