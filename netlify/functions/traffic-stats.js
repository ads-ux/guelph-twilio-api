// GA4 + Google Search Console stats proxy for the Guelph dashboard.
// Authenticates with a Google service account (held server-side as a Netlify
// env var) and returns aggregate Sessions (GA4) + Clicks/Impressions/Position
// (Search Console) as JSON. No secrets are ever sent to the browser.
//
// Required Netlify environment variable:
//   GOOGLE_SA_JSON  – the full service-account key file, pasted as-is (JSON).
// Optional:
//   DASH_KEY        – shared password; if set, callers must pass ?key=THAT
//
// The service account must be granted:
//   • Viewer on each GA4 property (Admin > Property Access Management)
//   • a user on each Search Console property (Settings > Users and permissions)
// and these APIs enabled in its Google Cloud project:
//   • Google Analytics Data API, Google Analytics Admin API, Search Console API
//
// Endpoint once deployed:
//   https://YOUR-SITE.netlify.app/.netlify/functions/traffic-stats?days=30

const crypto = require("crypto");

const GA4_PROPERTIES = ["538943078", "538967389", "538951845", "538919943"];
const GSC_SITES = [
  "sc-domain:guelphhydrovac.com","sc-domain:guelphdumpsterrental.com","https://toterental.ca/",
  "https://guelphroofers.com/","https://guelphbasementwaterproofing.com/","https://guelphcommercialcleaning.com/",
  "https://guelphmovers.com/","https://guelphmoldremoval.com/","https://guelphinterlocking.com/",
  "sc-domain:guelphtreeservice.com","sc-domain:guelphductcleaning.com","https://guelphdrywalling.com/",
  "https://guelphjunkremoval.com/","https://guelphairconditioning.com/","https://guelphwindowreplacement.com/",
  "https://guelphgeneralcontractor.com/","https://guelphelectrical.com/","sc-domain:guelphexcavation.com",
  "sc-domain:guelphwaterdamage.com","sc-domain:guelphfoundationrepair.com","https://guelphfencing.com/",
  "https://weprovideleads.com/","https://guelphwindowcleaning.ca/","https://guelphlawncare.ca/",
  "https://guelphcarpetcleaning.ca/","https://guelphdeckbuilder.com/","https://guelphappliancerepair.com/",
  "https://guelphexterminator.com/","https://guelphgaragedoor.com/","https://guelpheavestrough.com/",
  "sc-domain:jdhomesolutions.ca","sc-domain:barrieexteriorcleaning.ca",
];

const b64url = (buf) =>
  Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function getAccessToken(sa) {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/analytics.readonly https://www.googleapis.com/auth/webmasters.readonly",
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(`${header}.${claim}`);
  const sig = b64url(signer.sign(sa.private_key));
  const jwt = `${header}.${claim}.${sig}`;
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  });
  const j = await r.json();
  if (!j.access_token) throw new Error("token: " + JSON.stringify(j));
  return j.access_token;
}

async function ga4Property(id, token, startDate, endDate) {
  let name = id;
  try {
    const a = await fetch(`https://analyticsadmin.googleapis.com/v1beta/properties/${id}`, {
      headers: { Authorization: "Bearer " + token },
    });
    const aj = await a.json();
    if (aj.displayName) name = aj.displayName;
  } catch (_) {}
  let sessions = 0;
  try {
    const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${id}:runReport`, {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({ metrics: [{ name: "sessions" }], dateRanges: [{ startDate, endDate }] }),
    });
    const j = await r.json();
    sessions = parseInt((j.rows && j.rows[0] && j.rows[0].metricValues[0].value) || "0", 10);
  } catch (_) {}
  return [name, sessions];
}

async function gscSite(site, token, startDate, endDate) {
  try {
    const r = await fetch(
      `https://searchconsole.googleapis.com/webmasters/v3/sites/${encodeURIComponent(site)}/searchAnalytics/query`,
      {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify({ startDate, endDate, dimensions: [], rowLimit: 1 }),
      }
    );
    const j = await r.json();
    const row = (j.rows && j.rows[0]) || {};
    return [site, Math.round(row.clicks || 0), Math.round(row.impressions || 0), +(row.position || 0)];
  } catch (_) {
    return [site, 0, 0, 0];
  }
}

exports.handler = async (event) => {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "*",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers: cors, body: "" };

  const raw = process.env.GOOGLE_SA_JSON;
  const KEY = process.env.DASH_KEY;
  const params = event.queryStringParameters || {};
  if (KEY && params.key !== KEY)
    return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "unauthorized" }) };
  if (!raw)
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "GOOGLE_SA_JSON not set on this Netlify site" }) };

  let sa;
  try { sa = JSON.parse(raw); } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "GOOGLE_SA_JSON is not valid JSON" }) };
  }

  const days = Math.min(Math.max(parseInt(params.days || "30", 10) || 30, 1), 400);
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  try {
    const token = await getAccessToken(sa);
    const [ga4rows, gscrows] = await Promise.all([
      Promise.all(GA4_PROPERTIES.map((id) => ga4Property(id, token, startDate, endDate))),
      Promise.all(GSC_SITES.map((s) => gscSite(s, token, startDate, endDate))),
    ]);
    ga4rows.sort((a, b) => b[1] - a[1]);
    gscrows.sort((a, b) => b[1] - a[1] || b[2] - a[2]);
    const body = {
      date: endDate,
      days,
      ga4: [["GA4 property", "Sessions"], ...ga4rows],
      gsc: [["Site", "Clicks", "Impressions", "Average position"], ...gscrows],
    };
    return { statusCode: 200, headers: cors, body: JSON.stringify(body) };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: String((e && e.message) || e) }) };
  }
};
