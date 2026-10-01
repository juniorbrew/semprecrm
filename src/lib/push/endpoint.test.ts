import { describe, expect, it } from 'vitest'

import { isAllowedPushEndpoint } from './endpoint'

describe('isAllowedPushEndpoint', () => {
  it.each([
    'https://fcm.googleapis.com/fcm/send/abc:APA91b',
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAA',
    'https://web.push.apple.com/QGuQyavXutnMH',
    'https://api.push.apple.com/3/device/x',
    'https://wns2-par02p.notify.windows.com/w/?token=x',
    'https://android.googleapis.com/gcm/send/x',
  ])('accepts browser push service %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(true)
  })

  it.each([
    'http://fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com:8443/fcm/send/x',
    'https://user:pw@fcm.googleapis.com/x',
    'https://fcm.googleapis.com.evil.com/x',
    'https://evilpush.apple.com.attacker.net/x',
    'https://notify.windows.com.evil/x',
    'https://169.254.169.254/latest/meta-data',
    'https://127.0.0.1/x',
    'https://[::1]/x',
    'https://localhost/x',
    'https://10.0.0.5/x',
    'https://push.example/1',
    'not a url',
    'https://fcm.googleapis.com/' + 'a'.repeat(3000),
    null,
  ])('rejects %s', (url) => {
    expect(isAllowedPushEndpoint(url)).toBe(false)
  })
})
