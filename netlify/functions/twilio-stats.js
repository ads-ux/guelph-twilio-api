// Twilio stats proxy for the Guelph dashboard.
// Holds the Twilio Auth Token server-side (Netlify env var) and returns
// aggregate call + SMS counts as JSON. No secrets are ever sent to the browser.
//
// Required Netlify environment variables:
//   TWILIO_ACCOUNT_SID  – your Account SID (starts with AC...)
//   TWILIO_AUTH_TOKEN   – your Auth Token (keep secret)
// Optional:
//   DASH_KEY            – a shared password; if set, callers must pass ?key=THAT
//
// Endpoint once deployed:
//   https://YOUR-SITE.netlify.app/.netlify/functions/twilio-stats?days=30

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  const SID = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const KEY = process.env.DASH_KEY;

  if (!SID || !TOKEN) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set on this Netlify site" }) };
  }

  const params = event.queryStringParameters || {};
  if (KEY && params.key !== KEY) {
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "unauthorized" }) };
  }

  const days = Math.min(Math.max(parseInt(params.days || "30", 10) || 30, 1), 400);
  const sinceDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10); // YYYY-MM-DD
  const auth = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");

  async function pull(resource, dateField, arrayKey) {
    let url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/${resource}.json?${dateField}>=${sinceDate}&PageSize=1000`;
    const rows = [];
    let guard = 0;
    while (url && guard++ < 50) {
      const r = await fetch(url, { headers: { Authorization: auth } });
      if (!r.ok) throw new Error(`${resource} returned ${r.status}`);
      const j = await r.json();
      rows.push(...(j[arrayKey] || []));
      url = j.next_page_uri ? "https://api.twilio.com" + j.next_page_uri : null;
    }
    return rows;
  }

  try {
    const calls = await pull("Calls", "StartTime", "calls");
    const msgs = await pull("Messages", "DateSent", "messages");

    // Break down per phone number. For inbound, the tracked number is "to";
    // for outbound it's "from".
    const byNumber = {};
    const ensure = (n) => (byNumber[n] || (byNumber[n] = { number: n, inboundCalls: 0, outboundCalls: 0, inboundSms: 0, outboundSms: 0 }));

    for (const c of calls) {
      const inbound = c.direction === "inbound";
      const e = ensure(inbound ? c.to : c.from);
      inbound ? e.inboundCalls++ : e.outboundCalls++;
    }
    for (const m of msgs) {
      const inbound = m.direction === "inbound";
      const e = ensure(inbound ? m.to : m.from);
      inbound ? e.inboundSms++ : e.outboundSms++;
    }

    const totals = {
      calls: calls.length,
      inboundCalls: calls.filter((c) => c.direction === "inbound").length,
      messages: msgs.length,
      inboundSms: msgs.filter((m) => m.direction === "inbound").length,
    };

    return {
      statusCode: 200,
      headers: { ...cors, "Cache-Control": "public, max-age=300" },
      body: JSON.stringify({ days, since: sinceDate, totals, numbers: Object.values(byNumber) }),
    };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: String(e && e.message ? e.message : e) }) };
  }
};
