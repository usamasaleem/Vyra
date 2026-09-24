import webpush from 'web-push'
import {
  enqueueTeamAlerts, ensurePushKeys, forgetPushDevice, markAlertSent, unsentTeamAlerts,
  type DueAlert, type PushKeys, type QueryRunner,
} from '@vyra/db'

/**
 * Sending what the team needs to know to the phones that asked.
 *
 * Its own cadence, faster than the minute-long sweep: an alert is worth
 * something in the first minutes and very little after them, and the queries
 * are small. A failure to one device never stops the rest, and an alert with
 * no devices is still marked sent — recorded as reaching nobody, so it is not
 * retried forever and the count says what happened.
 */
export const TEAM_ALERT_INTERVAL_MS = 15_000

/** Who a push service can contact about this sender. It asks for a URL or a mailto. */
const SENDER = 'https://vyra-inbox.netlify.app'

export type Push = (
  device: { endpoint: string; p256dh: string; auth: string },
  payload: string,
  keys: PushKeys,
) => Promise<{ gone: boolean; ok: boolean }>

export const webPush: Push = async (device, payload, keys) => {
  try {
    await webpush.sendNotification(
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      payload,
      {
        vapidDetails: { subject: SENDER, publicKey: keys.publicKey, privateKey: keys.privateKey },
        // A customer waiting now; an alert delivered tomorrow is noise.
        TTL: 60 * 60,
        urgency: 'high',
      },
    )
    return { ok: true, gone: false }
  } catch (error) {
    const status = (error as { statusCode?: number }).statusCode
    // 404 and 410: the subscription no longer exists — uninstalled, or permission taken away.
    return { ok: false, gone: status === 404 || status === 410 }
  }
}

let keys: PushKeys | null = null

export async function sendTeamAlerts(
  run: QueryRunner,
  log: (fields: Record<string, unknown>) => void,
  push: Push = webPush,
): Promise<{ sent: number; delivered: number }> {
  keys ??= await ensurePushKeys(run)
  await enqueueTeamAlerts(run)
  const due = await unsentTeamAlerts(run)
  let delivered = 0
  for (const alert of due) {
    const reached = await deliver(run, alert, keys, push)
    delivered += reached.length
    await markAlertSent(run, { id: alert.id, delivered: reached.length, endpoints: reached })
    log({ event: 'team_alert.sent', alert: alert.id, tag: alert.tag, devices: alert.devices.length, delivered: reached.length })
  }
  return { sent: due.length, delivered }
}

async function deliver(run: QueryRunner, alert: DueAlert, keys: PushKeys, push: Push): Promise<string[]> {
  const payload = JSON.stringify({ title: alert.title, body: alert.body, url: alert.url, tag: alert.tag })
  const results = await Promise.all(alert.devices.map(async (device) => {
    const result = await push(device, payload, keys)
    if (result.gone) await forgetPushDevice(run, device.endpoint)
    return result.ok ? device.endpoint : null
  }))
  return results.filter((e): e is string => e !== null)
}
