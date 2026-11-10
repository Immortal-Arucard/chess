import webpush from 'web-push';

export async function sendPushNotification({ subscription, payload, publicKey, privateKey, subject, agent }) {
  if (!publicKey || !privateKey || !subscription || !subscription.endpoint) return { ok: false, gone: false, status: 0 };
  webpush.setVapidDetails(subject || 'mailto:cubzub@gmail.com', publicKey, privateKey);
  try {
    await webpush.sendNotification({
      endpoint: subscription.endpoint,
      keys: { p256dh: subscription.p256dh, auth: subscription.auth }
    }, JSON.stringify(payload), { TTL: 120, agent });
    return { ok: true, gone: false, status: 201 };
  } catch (err) {
    const status = Number(err && err.statusCode) || 0;
    return { ok: false, gone: status === 404 || status === 410, status };
  }
}

export async function deliverDue(query, vapid) {
  const due = await query('select chess_service.push_due() as due');
  const rows = due.rows[0].due || [];
  for (const row of rows) {
    const payload = { title: row.title, body: row.body, url: row.url, kind: row.kind };
    for (const subscription of row.subscriptions || []) {
      const result = await sendPushNotification({
        subscription,
        payload,
        publicKey: vapid.publicKey,
        privateKey: vapid.privateKey,
        subject: vapid.subject,
        agent: vapid.agent
      });
      if (result.gone) await query('select chess_service.push_forget($1)', [subscription.endpoint]);
    }
    await query('select chess_service.push_mark($1)', [row.id]);
  }
  return rows.length;
}
