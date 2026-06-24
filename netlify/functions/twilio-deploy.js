// One-time deploy helper for the Twilio Serverless "voicemail" function.
// Creds stay server-side (Netlify env). Token-guarded. Delete after use.
// The new source is POSTed in (never stored in this public repo).
//
// Modes:
//   GET  ?token=..&mode=inspect            -> service/env/current-build/versions/deps (rollback info)
//   POST ?token=..&mode=prepare            -> body = new source; uploads version + creates build; returns buildSid
//   GET  ?token=..&mode=status&build=BU..  -> build status
//   POST ?token=..&mode=release&build=BU.. -> deploy that build to prod env
//
// Safe: prepare carries over ALL existing function/asset versions + dependencies,
// swapping only the /voicemail function version. release is reversible by
// releasing the previous build sid.

const TOKEN = "deploy-9a4f1c7e2b6dvm";
const SERVICE = "ZS61cf3d2d0d5f92e14bb8fb8fe41f068e";
const VOICEMAIL_FN = "ZH924486656d30bc6c2df79d921990fe0a";
const BASE = "https://serverless.twilio.com/v1";
const UPLOAD = "https://serverless-upload.twilio.com/v1";

exports.handler = async (event) => {
  const cors = { "Access-Control-Allow-Origin": "*", "Content-Type": "application/json" };
  const SID = process.env.TWILIO_ACCOUNT_SID;
  const TK = process.env.TWILIO_AUTH_TOKEN;
  const p = event.queryStringParameters || {};
  if (p.token !== TOKEN) return { statusCode: 401, headers: cors, body: JSON.stringify({ error: "unauthorized" }) };
  if (!SID || !TK) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: "creds not set" }) };
  const auth = "Basic " + Buffer.from(`${SID}:${TK}`).toString("base64");

  const j = async (url, opts) => {
    const r = await fetch(url, opts);
    const t = await r.text();
    let body; try { body = JSON.parse(t); } catch (_) { body = { _raw: t }; }
    return { ok: r.ok, status: r.status, body };
  };
  const form = (obj) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(obj)) {
      if (Array.isArray(v)) v.forEach((x) => u.append(k, x));
      else u.append(k, v);
    }
    return u.toString();
  };

  async function getState() {
    const envs = await j(`${BASE}/Services/${SERVICE}/Environments?PageSize=20`, { headers: { Authorization: auth } });
    const env = (envs.body.environments || []).find((e) => (e.domain_suffix === "prod") || (e.domain_name || "").includes("-prod")) || (envs.body.environments || [])[0];
    const deps = await j(`${BASE}/Services/${SERVICE}/Environments/${env.sid}/Deployments?PageSize=1`, { headers: { Authorization: auth } });
    const currentBuildSid = (deps.body.deployments || [])[0] && (deps.body.deployments || [])[0].build_sid;
    const build = await j(`${BASE}/Services/${SERVICE}/Builds/${currentBuildSid}`, { headers: { Authorization: auth } });
    return {
      envSid: env.sid, envDomain: env.domain_name, currentBuildSid,
      functionVersions: build.body.function_versions || [],
      assetVersions: build.body.asset_versions || [],
      dependencies: build.body.dependencies || [],
    };
  }

  try {
    const mode = p.mode || "inspect";

    if (mode === "inspect") {
      const s = await getState();
      return { statusCode: 200, headers: cors, body: JSON.stringify(s, null, 2) };
    }

    if (mode === "vars") {
      const s = await getState();
      const v = await j(`${BASE}/Services/${SERVICE}/Environments/${s.envSid}/Variables?PageSize=50`, { headers: { Authorization: auth } });
      const keys = (v.body.variables || []).map((x) => x.key);
      return { statusCode: 200, headers: cors, body: JSON.stringify({ envSid: s.envSid, keys }, null, 2) };
    }

    if (mode === "status") {
      const b = await j(`${BASE}/Services/${SERVICE}/Builds/${p.build}`, { headers: { Authorization: auth } });
      return { statusCode: 200, headers: cors, body: JSON.stringify({ sid: p.build, status: b.body.status }, null, 2) };
    }

    if (mode === "prepare") {
      const source = event.isBase64Encoded ? Buffer.from(event.body || "", "base64").toString("utf8") : (event.body || "");
      if (!source || source.length < 200) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "source too short", len: source.length }) };
      const s = await getState();

      // upload a new version of the /voicemail function (multipart)
      const boundary = "----twlio" + Date.now();
      const parts = [];
      const field = (n, v) => parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${n}"\r\n\r\n${v}\r\n`));
      field("Path", "/voicemail");
      field("Visibility", "public");
      parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="Content"; filename="voicemail.js"\r\nContent-Type: application/javascript\r\n\r\n`));
      parts.push(Buffer.from(source, "utf8"));
      parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
      const upBody = Buffer.concat(parts);
      const up = await j(`${UPLOAD}/Services/${SERVICE}/Functions/${VOICEMAIL_FN}/Versions`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": `multipart/form-data; boundary=${boundary}` },
        body: upBody,
      });
      if (!up.ok) return { statusCode: 502, headers: cors, body: JSON.stringify({ step: "upload", up }, null, 2) };
      const newVersionSid = up.body.sid;

      // build = all existing function versions except the old voicemail one, plus the new one
      const keptFnVersions = (s.functionVersions || []).filter((v) => v.function_sid !== VOICEMAIL_FN).map((v) => v.sid);
      const fnVersions = [...keptFnVersions, newVersionSid];
      const assetVersions = (s.assetVersions || []).map((v) => v.sid);
      const buildForm = {
        FunctionVersions: fnVersions,
        Dependencies: JSON.stringify((s.dependencies || []).map((d) => ({ name: d.name, version: d.version }))),
      };
      if (assetVersions.length) buildForm.AssetVersions = assetVersions;
      const build = await j(`${BASE}/Services/${SERVICE}/Builds`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: form(buildForm),
      });
      if (!build.ok) return { statusCode: 502, headers: cors, body: JSON.stringify({ step: "build", build }, null, 2) };
      return { statusCode: 200, headers: cors, body: JSON.stringify({ rollbackBuildSid: s.currentBuildSid, envSid: s.envSid, newVersionSid, newBuildSid: build.body.sid, buildStatus: build.body.status }, null, 2) };
    }

    if (mode === "release") {
      const dep = await j(`${BASE}/Services/${SERVICE}/Environments/${p.env}/Deployments`, {
        method: "POST",
        headers: { Authorization: auth, "Content-Type": "application/x-www-form-urlencoded" },
        body: form({ BuildSid: p.build }),
      });
      if (!dep.ok) return { statusCode: 502, headers: cors, body: JSON.stringify({ step: "release", dep }, null, 2) };
      return { statusCode: 200, headers: cors, body: JSON.stringify({ deploymentSid: dep.body.sid, buildSid: dep.body.build_sid, envSid: p.env }, null, 2) };
    }

    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: "unknown mode" }) };
  } catch (e) {
    return { statusCode: 502, headers: cors, body: JSON.stringify({ error: String(e && e.message ? e.message : e) }) };
  }
};
