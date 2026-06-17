// Lists every voicemail (Twilio call recording) since day 1, joined to its
// call so we know which site was called and the caller's number.
// Endpoint: /.netlify/functions/twilio-voicemails
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
  if (!SID || !TOKEN) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Twilio creds not set" }) };
  const auth = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");

  const NUMBER_TO_SITE = {
    "+12262129386":"General Contractor","+12267902661":"Mold Removal","+12267900422":"Exterminator",
    "+12262435179":"Fencing","+12262121413":"Drywalling","+12267809397":"Hydrovac","+12267900369":"Lawn Care",
    "+12267809028":"Commercial Cleaning","+12267804558":"Movers","+12262868192":"Window Replacement",
    "+12262435199":"Dumpster Rental","+12267708678":"Junk Removal","+12267800880":"Excavation",
    "+12267801507":"Water Damage","+12267808069":"Duct Cleaning","+12267808624":"Tree Service",
    "+12267808295":"ToteRental.ca","+12267905018":"Electrical","+12267902967":"Roofers",
    "+12267809658":"Basement Waterproofing","+12267904349":"Interlocking","+12267808754":"Air Conditioning"
  };

  async function pull(path, key) {
    let url = `https://api.twilio.com/2010-04-01/Accounts/${SID}/${path}.json?PageSize=1000`;
    const rows = []; let guard = 0;
    while (url && guard++ < 60) {
      const r = await fetch(url, { headers: { Authorization: auth } });
      if (!r.ok) throw new Error(`${path} returned ${r.status}`);
      const j = await r.json();
      rows.push(...(j[key] || []));
      url = j.next_page_uri ? "https://api.twilio.com" + j.next_page_uri : null;
    }
    return rows;
  }

  try {
    const recs = await pull("Recordings", "recordings");
    const calls = await pull("Calls", "calls");
    const callMap = {};
    calls.forEach(c => { callMap[c.sid] = c; });

    const voicemails = recs.map(r => {
      const c = callMap[r.call_sid] || {};
      const to = c.to || "";
      return {
        date: r.date_created,
        site: NUMBER_TO_SITE[to] || to || "(unknown)",
        trackingNumber: to,
        caller: c.from || "",
        durationSec: +r.duration || 0,
        recordingSid: r.sid,
        recordingUrl: `https://api.twilio.com/2010-04-01/Accounts/${SID}/Recordings/${r.sid}.mp3`
      };
    }).sort((a, b) => new Date(b.date) - new Date(a.date));

    const bySite = {};
    voicemails.forEach(v => { bySite[v.site] = (bySite[v.site] || 0) + 1; });

    return { statusCode: 200, headers: cors, body: JSON.stringify({ count: voicemails.length, bySite, voicemails }) };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: String(e && e.message ? e.message : e) }) };
  }
};
