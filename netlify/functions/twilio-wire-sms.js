// One-time helper: point each Guelph number's Messaging ("A MESSAGE COMES IN")
// webhook at the voicemail function so inbound SMS replies get emailed to the team.
// Creds stay server-side (Netlify env). Token-guarded. Delete after use.
//
//   Dry run (no changes):  /.netlify/functions/twilio-wire-sms?token=TOKEN
//   Apply:                 /.netlify/functions/twilio-wire-sms?token=TOKEN&apply=1
//
// Only touches numbers whose VOICE webhook already points at the voicemail
// function (i.e. the Guelph fleet). Leaves voice config untouched.

const TOKEN = "wire-7f3a9c2e1b8d4necho";
const TARGET_SMS_URL = "https://guelph-voicemail-7815-prod.twil.io/voicemail";

exports.handler = async (event) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const SID = process.env.TWILIO_ACCOUNT_SID;
  const T = process.env.TWILIO_AUTH_TOKEN;
  const p = event.queryStringParameters || {};
  if (p.token !== TOKEN) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "unauthorized" }) };
  if (!SID || !T) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Twilio creds not set" }) };
  const auth = "Basic " + Buffer.from(`${SID}:${T}`).toString("base64");
  const apply = p.apply === "1";

  async function listNumbers() {
    let url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/IncomingPhoneNumbers.json?PageSize=1000`;
    const rows = []; let guard = 0;
    while (url && guard++ < 20) {
      const r = await fetch(url, { headers: { Authorization: auth } });
      if (!r.ok) throw new Error("list " + r.status);
      const j = await r.json();
      rows.push(...(j.incoming_phone_numbers || []));
      url = j.next_page_uri ? "https://api.twilio.com" + j.next_page_uri : null;
    }
    return rows;
  }

  try {
    const nums = await listNumbers();
    const fleet = nums.filter((n) => (n.voice_url || "").toLowerCase().includes("guelph-voicemail"));
    const results = [];
    for (const n of fleet) {
      const before = n.sms_url || "";
      const already = before === TARGET_SMS_URL;
      let status = already ? "already-set" : (apply ? "updating" : "would-update");
      if (apply && !already) {
        const body = new URLSearchParams({ SmsUrl: TARGET_SMS_URL, SmsMethod: "POST" }).toString();
        const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/IncomingPhoneNumbers/${n.sid}.json`, {
          method: "POST",
          headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
          body,
        });
        status = r.ok ? "updated" : ("error " + r.status);
      }
      results.push({ number: n.phone_number, name: n.friendly_name, before, after: TARGET_SMS_URL, status });
    }
    const counts = results.reduce((a, r) => ((a[r.status] = (a[r.status] || 0) + 1), a), {});
    return { statusCode: 200, headers: cors, body: JSON.stringify({ mode: apply ? "APPLY" : "DRY_RUN", fleetCount: fleet.length, counts, results }, null, 2) };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: String(e && e.message ? e.message : e) }) };
  }
};
