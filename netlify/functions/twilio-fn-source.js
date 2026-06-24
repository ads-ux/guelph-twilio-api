// Read-only: fetches the source of the Twilio Serverless "voicemail" function
// so we can extend it (missed-call-text-back) without breaking the live flow.
// Creds stay server-side (Netlify env). Returns the code text + discovery info.
// Endpoint: /.netlify/functions/twilio-fn-source   (optional ?key=DASH_KEY)

exports.handler = async (event) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const SID = process.env.TWILIO_ACCOUNT_SID;
  const TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const KEY = process.env.DASH_KEY;
  const params = event.queryStringParameters || {};
  if (KEY && params.key !== KEY) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "unauthorized" }) };
  if (!SID || !TOKEN) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "Twilio creds not set" }) };
  const auth = "Basic " + Buffer.from(`${SID}:${TOKEN}`).toString("base64");
  const get = async (url) => {
    const r = await fetch(url, { headers: { Authorization: auth } });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch (_) { j = { _raw: t }; }
    return { ok: r.ok, status: r.status, j };
  };

  try {
    // 1. Find the serverless service whose domain is guelph-voicemail-7815-*
    const svc = await get("https://serverless.twilio.com/v1/Services?PageSize=50");
    const services = (svc.j.services || []).map((s) => ({ sid: s.sid, unique_name: s.unique_name, friendly_name: s.friendly_name }));
    const match = (svc.j.services || []).find((s) =>
      (s.unique_name || "").includes("guelph-voicemail") ||
      (s.friendly_name || "").toLowerCase().includes("voicemail"));
    if (!match) return { statusCode: 200, headers: cors, body: JSON.stringify({ note: "service not found", services }, null, 2) };
    const serviceSid = match.sid;

    // 2. Find the /voicemail function
    const fns = await get(`https://serverless.twilio.com/v1/Services/${serviceSid}/Functions?PageSize=50`);
    const functions = (fns.j.functions || []).map((f) => ({ sid: f.sid, friendly_name: f.friendly_name }));
    const fn = (fns.j.functions || []).find((f) => (f.friendly_name || "").toLowerCase().includes("voicemail")) || (fns.j.functions || [])[0];
    if (!fn) return { statusCode: 200, headers: cors, body: JSON.stringify({ serviceSid, note: "no functions", functions }, null, 2) };

    // 3. Latest version of that function
    const vers = await get(`https://serverless.twilio.com/v1/Services/${serviceSid}/Functions/${fn.sid}/Versions?PageSize=5`);
    const versions = (vers.j.function_versions || []).map((v) => ({ sid: v.sid, path: v.path, visibility: v.visibility, date: v.date_created }));
    const latest = (vers.j.function_versions || [])[0];
    if (!latest) return { statusCode: 200, headers: cors, body: JSON.stringify({ serviceSid, functionSid: fn.sid, note: "no versions", versions }, null, 2) };

    // 4. Content of the latest version (correct host = serverless.twilio.com).
    const content = await get(`https://serverless.twilio.com/v1/Services/${serviceSid}/Functions/${fn.sid}/Versions/${latest.sid}/Content`);
    let code = content.j && content.j.content;
    // Some responses put a signed URL in `content` (or under `url`) instead of inline code.
    let via = "inline";
    const maybeUrl = (typeof code === "string" && /^https?:\/\//.test(code.trim())) ? code.trim()
                   : (content.j && content.j.url && /^https?:\/\//.test(content.j.url) && (!code || code.length < 5)) ? content.j.url : null;
    if (maybeUrl) {
      via = "url:" + maybeUrl;
      const r2 = await fetch(maybeUrl, { headers: { Authorization: auth } });
      code = await r2.text();
    }

    return {
      statusCode: 200,
      headers: cors,
      body: JSON.stringify({
        serviceSid, functionSid: fn.sid, latestVersion: latest.sid, path: latest.path,
        functions, versions,
        contentKeys: content.j ? Object.keys(content.j) : [],
        contentRaw: content.j,
        via,
        codeLength: (code || "").length,
        code,
      }, null, 2),
    };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: String(e && e.message ? e.message : e) }) };
  }
};
