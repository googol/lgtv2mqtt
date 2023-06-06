// This file has been inlined from https://github.com/terafin/homeautomation-js-lib/blob/ba1fcb73a8fe5887eb35d61ee4119ad00b12692a/mqtt_helpers.js
// the package was a dependency previously.
// The file has been edited to change the logging to be plain console, and to avoid mutating the mqtt import, since that was not used by the project in general
import * as assert from 'node:assert'
import mqtt from 'mqtt'
import _ from 'lodash'

function fix_name(str: string): string {
    str = str.replace(/[+\\&*%$#,@!’]/g, '')
    str = str.replace(/\s/g, '_').trim()
    str = str.replace(/__/g, '_')
    str = str.replace(/-/g, '_')

    return str
}

export function setupClient(connectedCallback: () => void, disconnectedCallback: () => void): mqtt.MqttClient {
    const host = process.env.MQTT_HOST
    const mqttUsername = process.env.MQTT_USER
    const mqttPassword = process.env.MQTT_PASS
    const mqttName = process.env.MQTT_NAME
    const statusTopicPrefix = process.env.MQTT_STATUS_TOPIC_PREFIX ?? '/status/'

    assert.ok(mqttUsername)
    assert.ok(mqttPassword)

    let logName = mqttName

    if (_.isNil(logName)) {
        logName = process.env.name
    }

    if (_.isNil(logName)) {
        logName = process.env.LOGGING_NAME
    }

    if (_.isNil(host)) {
        console.warn('MQTT_HOST not set, aborting')
        process.abort()
    }

    const mqtt_options: mqtt.IClientOptions = {
        username: mqttUsername,
        password: mqttPassword,
    }

    if (logName !== undefined) {
        mqtt_options.will = {
            topic: fix_name(statusTopicPrefix + logName),
            payload: '0',
            retain: true,
            qos: 0,
        }
    }

    const client = mqtt.connect(host, mqtt_options)

    // MQTT Observation

    client.on('connect', () => {
        console.info('MQTT Connected')

        if (!_.isNil(logName)) {
            client.publish(fix_name('/status/' + logName), '1', { retain: true })
        }

        if (!_.isNil(connectedCallback)) {
            connectedCallback()
        }
    })

    client.on('disconnect', () => {
        console.error('MQTT Disconnected, reconnecting')

        client.reconnect()

        if (!_.isNil(disconnectedCallback)) {
            disconnectedCallback()
        }
    })

    return client
}
