// This file has been inlined from https://github.com/terafin/homeautomation-js-lib/blob/ba1fcb73a8fe5887eb35d61ee4119ad00b12692a/mqtt_helpers.js
// the package was a dependency previously.
// The file has been edited to change the logging to be plain console, and to avoid mutating the mqtt import, since that was not used by the project in general
const mqtt = require('mqtt')
const _ = require('lodash')

const fix_name = function(str) {
    str = str.replace(/[+\\&*%$#,@!’]/g, '')
    str = str.replace(/\s/g, '_').trim()
    str = str.replace(/__/g, '_')
    str = str.replace(/-/g, '_')

    return str
}

exports.setupClient = function(connectedCallback, disconnectedCallback) {
    const host = process.env.MQTT_HOST
    const mqttUsername = process.env.MQTT_USER
    const mqttPassword = process.env.MQTT_PASS
    const mqttName = process.env.MQTT_NAME
    var statusTopicPrefix = process.env.MQTT_STATUS_TOPIC_PREFIX

    var logName = mqttName

    if (_.isNil(logName)) {
        logName = process.env.name
    }

    if (_.isNil(logName)) {
        logName = process.env.LOGGING_NAME
    }

    if (_.isNil(statusTopicPrefix)) {
        statusTopicPrefix = '/status/'
    }

    if (_.isNil(host)) {
        console.warn('MQTT_HOST not set, aborting')
        process.abort()
    }

    var mqtt_options = {}

    if (!_.isNil(mqttUsername)) {
        mqtt_options.username = mqttUsername
    }
    if (!_.isNil(mqttPassword)) {
        mqtt_options.password = mqttPassword
    }

    if (!_.isNil(logName)) {
        mqtt_options.will = {}
        mqtt_options.will.topic = fix_name(statusTopicPrefix + logName)
        mqtt_options.will.payload = '0'
        mqtt_options.will.retain = true
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

        client.connect(host)

        if (!_.isNil(disconnectedCallback)) {
            disconnectedCallback()
        }
    })

    return client
}
