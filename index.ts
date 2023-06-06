#!/usr/bin/env node

import Lgtv from 'lgtv2'
import _ from 'lodash'
import wol from 'wol'
import * as mqtt_helpers from './homeautomation-js-lib/mqtt_helpers'

let tvOn: boolean = false
let requestedTVOn: boolean | null = null
let mqttConnected: boolean = false
let tvConnected: boolean = false
let lastError: unknown
let foregroundApp: unknown = null

const tvMAC = process.env.TV_MAC
const tvIP = process.env.TV_IP

const mqttOptions = { retain: true, qos: 1 } as const
var topic_prefix = process.env.TOPIC_PREFIX

if (_.isNil(topic_prefix)) {
    console.error('TOPIC_PREFIX not set, not starting')
    process.abort()
}


console.info('lgtv2mqtt starting')

const mqtt = mqtt_helpers.setupClient(function() {
    mqttConnected = true

    mqtt.publish(topic_prefix + '/connected', tvConnected ? '1' : '0', mqttOptions)

    console.info('mqtt subscribe', topic_prefix + '/set/#')
    mqtt.subscribe(topic_prefix + '/set/#', { qos: 1 })
}, function() {
    if (mqttConnected) {
        mqttConnected = false
        console.error('mqtt disconnected')
    }
})

const powerOff = function() {
    console.info('powerOff (isOn? ' + tvOn + ')')
    if (tvOn) {
        console.info('lg > ssap://system/turnOff')
        lgtv.request('ssap://system/turnOff')
        tvOn = false
        requestedTVOn = false
    }
}

const lgtv = new Lgtv({
    url: 'ws://' + tvIP + ':3000',
    reconnect: 1000
})

mqtt.on('error', err => {
    console.error('mqtt: ' + err)
})

mqtt.on('message', (inTopic, inPayload) => {
    var topic = inTopic
    var payload = inPayload.toString('utf8')
    console.info('mqtt <' + topic + ':' + payload)

    if (topic[0] == '/') {
        topic = topic.substring(1)
    }

    const parts = topic.split('/')

    switch (parts[1]) {
        case 'set':
            switch (parts[2]) {
                case 'toast':
                    lgtv.request('ssap://system.notifications/createToast', { message: payload })
                    break
                case 'volume':
                    lgtv.request('ssap://audio/setVolume', { volume: parseInt(payload, 10) })
                    break
                case 'mute':
                    if (payload === 'true') {
                        lgtv.request('ssap://audio/setMute', { mute: true })
                    }
                    if (payload === 'false') {
                        lgtv.request('ssap://audio/setMute', { mute: false })
                    }
                    break

                case 'input':
                    console.info('lg > ssap://tv/switchInput', { inputId: payload })
                    lgtv.request('ssap://tv/switchInput', { inputId: payload })
                    break

                case 'launch':
                    lgtv.request('ssap://system.launcher/launch', { id: payload })
                    break

                case 'powerOn':
                    console.info('powerOn (isOn? ' + tvOn + ')')
                    if (tvMAC === undefined) {
                        return
                    }

                    wol.wake(tvMAC, function(err, res) {
                        if (err !== undefined) {
                            console.error(`Failed to wake up LGTV via WOL`, err)
                            return
                        }
                        console.info('WOL: ' + res)
                        requestedTVOn = true
                        if (foregroundApp == null) {
                            console.info('lg > ssap://system/turnOff (to turn it on...)')
                            lgtv.request('ssap://system/turnOff')
                        }
                    })

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

                default:
                    console.info('lg > ' + 'ssap://' + inPayload)
                    lgtv.request('ssap://' + inPayload)
            }
            break
        default:
    }
})

lgtv.on('prompt', () => {
    console.info('authorization required')
})

lgtv.on('connect', () => {
    tvOn = true
    let channelsSubscribed = false
    lastError = null
    tvConnected = true
    console.info('tv connected')
    mqtt.publish(topic_prefix + '/connected', '1', mqttOptions)

    lgtv.subscribe('ssap://audio/getVolume', (err, res) => {
        console.info('audio/getVolume', err, res)
        if (res.changed.indexOf('volume') !== -1) {
            mqtt.publish(topic_prefix + '/status/volume', String(res.volume), mqttOptions)
        }
        if (res.changed.indexOf('muted') !== -1) {
            mqtt.publish(topic_prefix + '/status/mute', res.muted ? '1' : '0', mqttOptions)
        }
    })

    lgtv.subscribe('ssap://com.webos.applicationManager/getForegroundAppInfo', (err, res) => {
        console.info('getForegroundAppInfo', err, res)
        mqtt.publish(topic_prefix + '/status/foregroundApp', String(res.appId), mqttOptions)

        if (!_.isNil(res.appId) && res.appId.length > 0) {
            tvOn = true
            foregroundApp = res.appId
        } else {
            tvOn = false
            foregroundApp = null
        }

        if (res.appId === 'com.webos.app.livetv') {
            if (!channelsSubscribed) {
                channelsSubscribed = true
                setTimeout(() => {
                    lgtv.subscribe('ssap://tv/getCurrentChannel', (err, res) => {
                        if (err) {
                            console.error(err)
                            return
                        }
                        const msg = {
                            val: res.channelNumber,
                            lgtv: res
                        }
                        mqtt.publish(topic_prefix + '/status/currentChannel', JSON.stringify(msg), mqttOptions)
                    })
                }, 2500)
            }
        }
    })

    lgtv.subscribe('ssap://tv/getExternalInputList', function(err, res) {
        console.info('getExternalInputList', err, res)
    })

    if (requestedTVOn == false) {
        powerOff()
    }
})

lgtv.on('connecting', host => {
    console.info('tv trying to connect', host)
})

lgtv.on('close', () => {
    lastError = null
    tvConnected = false
    console.info('tv disconnected')
    mqtt.publish(topic_prefix + '/connected', '0', mqttOptions)
})

lgtv.on('error', err => {
    const str = String(err)
    if (str !== lastError) {
        console.error('tv error: ' + str)
    }
    lastError = str
})

const sendPointerEvent = function(type: string, payload: { name: string }) {
    lgtv.getSocket(
        'ssap://com.webos.service.networkinput/getPointerInputSocket',
        (err, sock) => {
            if (!err) {
                sock.send(type, payload)
            }
        }
    )
}
