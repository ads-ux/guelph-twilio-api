// Read-only diagnostic: reports how each Twilio number routes voice calls,
// so we can add missed-call-text-back without breaking live forwarding.
// Secrets (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) stay server-side in Netlify
// env vars and are never returned to the caller.
//
// Endpoint: /.netlify/functions/twilio-config
// Optional: DASH_KEY env var; if set, caller must pass ?key=THAT

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
  const params = event.queryStringParameters || {};
  if (KEY && params.key !== KEY)
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "unauthorized" }) };
  if (!SID || !TOKEN)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN not set" }) };

  const auth = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");

  async function pull(path, key) {
    let url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/${path}.json?PageSize=1000`;
    const rows = []; let guard = 0;
    while (url && guard++ < 30) {
      const r = await fetch(url, { headers: { Authorization: auth } });
      if (!r.ok) throw new Error(`${path} returned ${r.status}`);
      const j = await r.json();
      rows.push(...(j[key] || []));
      url = j.next_page_uri ? "https://api.twilio.com" + j.next_page_uri : null;
    }
    return rows;
  }

  function classify(n) {
    if (n.voice_application_sid) return "TwiML App";
    const u = (n.voice_url || "").toLowerCase();
    if (!u) return "none";
    if (u.includes("/flows/") || (u.includes("webhooks.twilio.com") && u.includes("flow"))) return "Studio Flow";
    if (u.includes("handler.twilio.com")) return "TwiML Bin";
    if (u.includes("guelph-twilio-api")) return "Our Netlify function";
    try { return "Custom webhook (" + new URL(n.voice_url).host + ")"; } catch (_) { return "Custom webhook"; }
  }

  try {
    const nums = await pull("IncomingPhoneNumbers", "incoming_phone_numbers");
    const numbers = nums.map((n) => ({
      number: n.phone_number,
      name: n.friendly_name,
      routing: classify(n),
      voiceUrl: n.voice_url || "",
      voiceMethod: n.voice_method || "",
      voiceAppSid: n.voice_application_sid || "",
      voiceFallbackUrl: n.voice_fallback_url || "",
      smsUrl: n.sms_url || "",
      statusCallback: n.status_callback || "",
      smsCapable: !!(n.capabilities && n.capabilities.sms),
    })).sort((a, b) => a.name.localeCompare(b.name));

    // Summaries
    const byRouting = {};
    numbers.forEach((n) => { byRouting[n.routing] = (byRouting[n.routing] || 0) + 1; });
    const distinctVoiceUrls = [...new Set(numbers.map((n) => n.voiceUrl).filter(Boolean))];
    const distinctAppSids = [...new Set(numbers.map((n) => n.voiceAppSid).filter(Boolean))];

    // If a TwiML App is in use, fetch its voice config too.
    let twimlApps = [];
    if (distinctAppSids.length) {
      const apps = await pull("Applications", "applications");
      twimlApps = apps
        .filter((a) => distinctAppSids.includes(a.sid))
        .map((a) => ({ sid: a.sid, name: a.friendly_name, voiceUrl: a.voice_url, voiceMethod: a.voice_method }));
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        count: numbers.length,
        byRouting,
        distinctVoiceUrls,
        distinctAppSids,
        twimlApps,
        numbers,
      }, null, 2),
    };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: String(e && e.message ? e.message : e) }) };
  }
};
