// Threshold — backend server
// Handles: placing outbound AI calls via Retell, and receiving call result webhooks.
//
// Setup:
//   1. npm install
//   2. Copy .env.example to .env and fill in your real values
//   3. npm start
//   4. Deploy to Railway (or similar) so Retell's webhook can reach a public URL

const express = require("express");
const cors = require("cors");
const { createClient } = require("@supabase/supabase-js");
const { registerSiteBuilderRoutes } = require("./sitebuilder");
const { registerBillingRoutes } = require("./billing");

const app = express();

// CORS — allow the browser frontend to call this API.
// Must run before any routes are registered, and must answer OPTIONS
// preflight requests or browsers will block every POST.
app.use(cors({
  origin: true,            // reflect whatever origin is asking
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "stripe-signature"],
}));

// Preflight OPTIONS requests are handled by the middleware below,
// which works consistently across Express versions.

// Belt-and-braces: set the headers manually too, in case anything
// bypasses the cors() middleware.
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", req.headers.origin || "*");
  res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, stripe-signature");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// Simple health check so you can confirm the backend is alive in a browser.
app.get("/", (req, res) => res.json({ status: "ok", service: "threshold-backend" }));

/* -----------------------------------------------------------
   GET /api/diagnostics
   Open this in your browser to see exactly what's configured
   and what Retell says. Reports problems in plain language.
----------------------------------------------------------- */
app.get("/api/diagnostics", async (req, res) => {
  const report = { summary: "", problems: [], checks: [] };

  function check(name, ok, detail) {
    report.checks.push({ name, ok: ok ? "PASS" : "FAIL", detail });
    if (!ok) report.problems.push(`${name} — ${detail}`);
  }

  check("Supabase URL configured", !!SUPABASE_URL, SUPABASE_URL ? "ok" : "missing");
  check("Supabase key configured", !!SUPABASE_SERVICE_KEY, SUPABASE_SERVICE_KEY ? "ok" : "missing");
  check("Retell API key configured", !!RETELL_API_KEY, RETELL_API_KEY ? "ok" : "MISSING — add RETELL_API_KEY in Railway Variables");
  check("Retell agent ID configured", !!RETELL_AGENT_ID, RETELL_AGENT_ID || "MISSING — add RETELL_AGENT_ID in Railway Variables");
  check("Retell from-number configured", !!RETELL_FROM_NUMBER, RETELL_FROM_NUMBER || "MISSING — add RETELL_FROM_NUMBER in Railway Variables");

  const normalized = toE164(RETELL_FROM_NUMBER);
  check("From-number format valid", !!normalized,
    normalized ? `${RETELL_FROM_NUMBER} reads as ${normalized}` : `"${RETELL_FROM_NUMBER}" is not valid. Use +1 then 10 digits.`);

  if (RETELL_API_KEY) {
    try {
      const r = await fetch("https://api.retellai.com/list-phone-numbers", {
        headers: { Authorization: `Bearer ${RETELL_API_KEY}` },
      });
      const text = await r.text();

      if (r.status === 401 || r.status === 403) {
        check("Retell API key accepted", false, "Retell rejected your API key. Check for typos or extra spaces in Railway.");
      } else if (!r.ok) {
        check("Retell reachable", false, `Retell returned ${r.status}: ${text.slice(0, 300)}`);
      } else {
        check("Retell API key accepted", true, "ok");
        let numbers = [];
        try { numbers = JSON.parse(text); } catch { numbers = []; }
        if (!Array.isArray(numbers)) numbers = [];

        // Retell replaced outbound_agent_id with an outbound_agents array
        // (deprecation effective 2026-03-31). Support both, preferring the new one.
        function agentsOf(n, kind) {
          const list = n[`${kind}_agents`];
          if (Array.isArray(list) && list.length) return list.map((a) => a.agent_id);
          const legacy = n[`${kind}_agent_id`];
          return legacy ? [legacy] : [];
        }

        report.numbers_in_your_retell_account = numbers.map((n) => ({
          number: n.phone_number,
          outbound_agents: agentsOf(n, "outbound"),
          inbound_agents: agentsOf(n, "inbound"),
        }));

        const match = numbers.find((n) => n.phone_number === normalized);
        check("From-number found in Retell", !!match,
          match ? "ok" : `${normalized} not found. Your account has: ${numbers.map(n => n.phone_number).join(", ") || "no numbers"}`);

        if (match) {
          const outbound = agentsOf(match, "outbound");
          check("Outbound agent bound to number", outbound.length > 0,
            outbound.length
              ? `bound to ${outbound.join(", ")}`
              : "No outbound agent bound. In Retell, open this phone number and set 'Outbound Call Agent' to your agent, then save. Or visit /api/fix-outbound-agent to bind it automatically.");
        }
      }
    } catch (err) {
      check("Retell reachable", false, `Network error: ${err.message}`);
    }

    // Fetch the agent itself so you can see which prompt Retell actually has.
    if (RETELL_AGENT_ID) {
      try {
        const aRes = await fetch(`https://api.retellai.com/get-agent/${encodeURIComponent(RETELL_AGENT_ID)}`, {
          headers: { Authorization: `Bearer ${RETELL_API_KEY}` },
        });
        const aText = await aRes.text();
        if (aRes.ok) {
          let agent = {};
          try { agent = JSON.parse(aText); } catch { agent = {}; }
          report.your_agent = {
            agent_id: agent.agent_id,
            agent_name: agent.agent_name,
            version: agent.version,
            voice_id: agent.voice_id,
            response_engine: agent.response_engine,
            is_published: agent.is_published,
          };
          check("Agent found in Retell", true, `${agent.agent_name || "unnamed"} (version ${agent.version})`);

          // If this is a conversation flow agent, inspect the flow itself —
          // that's where the prompt text and variable config actually live.
          const engine = agent.response_engine || {};
          report.flow_lookup_attempted = engine.conversation_flow_id || "no conversation_flow_id on agent";

          if (engine.conversation_flow_id) {
            const flowId = engine.conversation_flow_id;
            const urls = [
              `https://api.retellai.com/get-conversation-flow/${encodeURIComponent(flowId)}`,
              `https://api.retellai.com/get-conversation-flow/${encodeURIComponent(flowId)}?version=${engine.version || agent.version}`,
            ];

            let flow = null;
            let lastErr = "";
            for (const u of urls) {
              try {
                const fRes = await fetch(u, { headers: { Authorization: `Bearer ${RETELL_API_KEY}` } });
                const fText = await fRes.text();
                if (fRes.ok) {
                  try { flow = JSON.parse(fText); } catch { lastErr = "could not parse flow JSON"; }
                  if (flow) break;
                } else {
                  lastErr = `${fRes.status} from ${u} — ${fText.slice(0, 150)}`;
                }
              } catch (err) {
                lastErr = err.message;
              }
            }

            if (!flow) {
              check("Conversation flow readable", false, lastErr || "unknown error");
            } else {
              const nodes = Array.isArray(flow.nodes) ? flow.nodes : [];
              const allText = JSON.stringify(flow);

              report.your_flow = {
                conversation_flow_id: flow.conversation_flow_id,
                node_count: nodes.length,
                default_dynamic_variables: flow.default_dynamic_variables || "none set",
                global_prompt_preview: (flow.global_prompt || "").slice(0, 300) || "none",
                nodes: nodes.map((n) => ({
                  id: n.id,
                  type: n.type,
                  text_preview: (
                    (n.instruction && n.instruction.text) ||
                    n.static_text ||
                    n.text ||
                    ""
                  ).slice(0, 250),
                })),
              };

              check("Flow uses {{business_name}}", allText.includes("{{business_name}}"),
                allText.includes("{{business_name}}")
                  ? "found in your flow"
                  : "NOT FOUND — add {{business_name}} to your node text where you want the name spoken");
              check("Flow uses {{lead_name}}", allText.includes("{{lead_name}}"),
                allText.includes("{{lead_name}}") ? "found" : "not used (optional)");
            }
          }

          check("Agent is published", agent.is_published === true,
            agent.is_published
              ? "ok"
              : "NOT PUBLISHED. In Retell, click Publish on your agent. Unpublished changes don't reach live calls.");
        } else {
          check("Agent found in Retell", false, `Retell returned ${aRes.status} for agent ${RETELL_AGENT_ID}: ${aText.slice(0, 200)}`);
        }
      } catch (err) {
        check("Agent lookup", false, err.message);
      }
    }
  }

  report.summary = report.problems.length === 0
    ? "All checks passed. If calls still fail, check your Retell account balance."
    : `${report.problems.length} problem(s) found. Read 'problems' below.`;

  res.json(report);
});

const RETELL_API_KEY = process.env.RETELL_API_KEY;
const RETELL_AGENT_ID = process.env.RETELL_AGENT_ID;
const RETELL_FROM_NUMBER = process.env.RETELL_FROM_NUMBER; // your Retell/Twilio phone number, e.g. "+14105550100"
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key — backend only, never expose to frontend

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Stripe webhook needs the raw request body to verify its signature,
// so it must be registered BEFORE express.json() runs on the request.
registerBillingRoutes(app, supabase);

// Every other route can use normal JSON parsing.
app.use(express.json({ limit: "2mb" }));

/* -----------------------------------------------------------
   GET /api/fix-outbound-agent
   Binds your agent to your phone number directly through Retell's
   API, bypassing the dashboard. Visit this once in a browser.
----------------------------------------------------------- */
app.get("/api/fix-outbound-agent", async (req, res) => {
  if (!RETELL_API_KEY || !RETELL_AGENT_ID || !RETELL_FROM_NUMBER) {
    return res.status(400).json({
      error: "Missing config. Need RETELL_API_KEY, RETELL_AGENT_ID and RETELL_FROM_NUMBER in Railway.",
    });
  }

  const number = toE164(RETELL_FROM_NUMBER);
  if (!number) {
    return res.status(400).json({ error: `"${RETELL_FROM_NUMBER}" is not a valid phone number.` });
  }

  try {
    // Retell's current API uses weighted agent lists, not single agent IDs.
    // For a single agent, use one entry with weight 1.
    const patchRes = await fetch(`https://api.retellai.com/update-phone-number/${encodeURIComponent(number)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${RETELL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        outbound_agents: [{ agent_id: RETELL_AGENT_ID, weight: 1 }],
        inbound_agents: [{ agent_id: RETELL_AGENT_ID, weight: 1 }],
      }),
    });

    const text = await patchRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!patchRes.ok) {
      console.error("Failed to bind agent:", patchRes.status, text);
      return res.status(502).json({
        success: false,
        status: patchRes.status,
        retell_said: data,
        hint: "If this failed, the agent ID or number may be wrong. Check /api/diagnostics.",
      });
    }

    res.json({
      success: true,
      message: "Agent bound to your phone number. Outbound calling should now work.",
      number,
      outbound_agents: data.outbound_agents || [{ agent_id: RETELL_AGENT_ID, weight: 1 }],
      inbound_agents: data.inbound_agents || [{ agent_id: RETELL_AGENT_ID, weight: 1 }],
      next_step: "Open /api/diagnostics to confirm, then try a call from your site.",
    });
  } catch (err) {
    console.error("Error binding agent:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* -----------------------------------------------------------
   GET /api/tune-agent
   Sets the speech settings that make the agent feel less robotic:
   backchanneling, ambient sound, fast responsiveness.
   Visit this once in a browser after changing anything.
----------------------------------------------------------- */
app.get("/api/tune-agent", async (req, res) => {
  if (!RETELL_API_KEY || !RETELL_AGENT_ID) {
    return res.status(400).json({ error: "Need RETELL_API_KEY and RETELL_AGENT_ID in Railway." });
  }

  // Allow overriding via query string, e.g. /api/tune-agent?ambient=office
  const ambient = req.query.ambient || "static-noise";
  const frequency = req.query.frequency ? Number(req.query.frequency) : 0.7;

  const settings = {
    enable_backchannel: true,
    backchannel_frequency: frequency,
    backchannel_words: ["yeah", "okay", "got it", "right", "mhm"],
    responsiveness: 1,
    interruption_sensitivity: 0.9,
    enable_dynamic_responsiveness: false,
    ambient_sound: ambient,
    ambient_sound_volume: 0.3,
    voice_speed: 1,
  };

  try {
    const r = await fetch(`https://api.retellai.com/update-agent/${encodeURIComponent(RETELL_AGENT_ID)}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${RETELL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(settings),
    });

    const text = await r.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }

    if (!r.ok) {
      console.error("Failed to tune agent:", r.status, text);
      return res.status(502).json({
        success: false,
        status: r.status,
        retell_said: data,
        hint: "If ambient_sound was rejected, try /api/tune-agent?ambient=none",
      });
    }

    res.json({
      success: true,
      message: "Agent tuned. Backchanneling on, ambient sound added, responsiveness maxed.",
      applied: {
        backchannel: data.enable_backchannel,
        backchannel_frequency: data.backchannel_frequency,
        backchannel_words: data.backchannel_words,
        responsiveness: data.responsiveness,
        interruption_sensitivity: data.interruption_sensitivity,
        ambient_sound: data.ambient_sound,
      },
      note: "You may need to publish the agent in Retell for changes to reach live calls.",
      tips: {
        less_chatty: "Visit /api/tune-agent?frequency=0.4",
        no_background_noise: "Visit /api/tune-agent?ambient=none",
        other_ambient_options: "coffee-shop, convention-hall, summer-outdoor, mountain-outdoor, static-noise, call-center",
      },
    });
  } catch (err) {
    console.error("Error tuning agent:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* -----------------------------------------------------------
   POST /api/calls/start
   Body: { orgId, leadId, leadName, leadNumber, businessName }
   Places a real outbound call via Retell AI, using the lead's
   business info as dynamic variables the agent can reference.
----------------------------------------------------------- */
/* Convert whatever the user typed into E.164 format (+1XXXXXXXXXX),
   which is the only format Retell accepts. Handles "(410) 555-0100",
   "410-555-0100", "4105550100", "1-410-555-0100", etc. */
function toE164(raw) {
  if (!raw) return null;
  const trimmed = String(raw).trim();
  if (trimmed.startsWith("+")) return trimmed.replace(/[^\d+]/g, "");
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (digits.length > 11) return `+${digits}`;
  return null; // too short to be valid
}

app.post("/api/calls/start", async (req, res) => {
  const { orgId, leadId, leadName, leadNumber, businessName } = req.body || {};

  if (!orgId || !leadId || !leadNumber) {
    return res.status(400).json({ error: "orgId, leadId, and leadNumber are required" });
  }

  const toNumber = toE164(leadNumber);
  if (!toNumber) {
    return res.status(400).json({ error: `"${leadNumber}" doesn't look like a valid phone number.` });
  }

  const fromNumber = toE164(RETELL_FROM_NUMBER);
  if (!fromNumber) {
    return res.status(500).json({ error: "The calling number isn't configured correctly on the server." });
  }

  console.log("Call variables →", JSON.stringify({
    lead_name: String(leadName || "there"),
    business_name: String(businessName || "your business"),
  }));

  try {
    // Check org's remaining minutes before placing the call (skip check for platform owner)
    const { data: org } = await supabase
      .from("organizations")
      .select("is_platform_owner")
      .eq("id", orgId)
      .single();

    if (!org) return res.status(404).json({ error: "Organization not found" });

    if (!org.is_platform_owner) {
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("minutes_used, minutes_included, status")
        .eq("org_id", orgId)
        .single();

      if (!sub || sub.status !== "active") {
        return res.status(402).json({ error: "No active subscription" });
      }
      if (sub.minutes_used >= sub.minutes_included) {
        return res.status(402).json({ error: "Minute limit reached. Upgrade your plan to keep calling." });
      }
    }

    // Place the call via Retell AI
    const retellRes = await fetch("https://api.retellai.com/v2/create-phone-call", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RETELL_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from_number: fromNumber,
        to_number: toNumber,
        override_agent_id: RETELL_AGENT_ID,
        // Without this, Retell may use an older saved version of the agent
        // instead of the one you most recently published.
        override_agent_version: "latest_published",
        retell_llm_dynamic_variables: {
          lead_name: String(leadName || "there"),
          business_name: String(businessName || "your business"),
        },
        metadata: { orgId, leadId }, // comes back on the webhook so we know which lead/org this call belongs to
      }),
    });

    const retellText = await retellRes.text();
    let retellData;
    try { retellData = JSON.parse(retellText); } catch { retellData = { raw: retellText }; }

    if (!retellRes.ok) {
      console.error("Retell rejected the call:", retellRes.status, retellText);
      const reason =
        (retellData && (retellData.message || retellData.error || retellData.detail)) ||
        retellText ||
        "Unknown error";
      return res.status(502).json({ error: `Retell: ${reason}` });
    }

    // Log the call as in-progress
    await supabase.from("call_logs").insert({
      org_id: orgId,
      lead_id: leadId,
      external_call_id: retellData.call_id,
      outcome: "in-progress",
    });

    res.json({ success: true, callId: retellData.call_id });
  } catch (err) {
    console.error("Error starting call:", err);
    res.status(500).json({ error: "Internal error placing call" });
  }
});

/* -----------------------------------------------------------
   POST /api/webhooks/retell
   Retell calls this URL when a call ends, with the transcript,
   recording, and outcome. Set this URL in your Retell dashboard
   under Agent settings -> Webhook.
----------------------------------------------------------- */
app.post("/api/webhooks/retell", async (req, res) => {
  const event = req.body;

  // Retell sends different event types; we care about call_ended / call_analyzed
  if (event.event !== "call_ended" && event.event !== "call_analyzed") {
    return res.status(200).send("ignored");
  }

  const call = event.call;
  const orgId = call.metadata && call.metadata.orgId;
  const leadId = call.metadata && call.metadata.leadId;

  if (!orgId) {
    console.warn("Webhook received with no orgId in metadata, skipping DB update");
    return res.status(200).send("no org");
  }

  // Map Retell's outcome signals to our simpler outcome labels
  let outcome = "completed";
  if (call.disconnection_reason === "voicemail_reached") outcome = "voicemail";
  else if (call.disconnection_reason === "dial_no_answer") outcome = "no-answer";
  else if (call.call_analysis && call.call_analysis.call_successful === true) outcome = "booked";
  else if (call.call_analysis && call.call_analysis.call_successful === false) outcome = "declined";

  const durationSeconds = call.end_timestamp && call.start_timestamp
    ? Math.round((call.end_timestamp - call.start_timestamp) / 1000)
    : 0;

  // Update the existing call_log row (matched by external_call_id)
  await supabase
    .from("call_logs")
    .update({
      outcome,
      duration_seconds: durationSeconds,
      transcript: call.transcript_object || null,
      recording_url: call.recording_url || null,
      ended_at: new Date().toISOString(),
    })
    .eq("external_call_id", call.call_id);

  // Increment the org's minutes_used
  if (durationSeconds > 0) {
    const minutesUsed = durationSeconds / 60;
    const { data: sub } = await supabase
      .from("subscriptions")
      .select("minutes_used")
      .eq("org_id", orgId)
      .single();
    if (sub) {
      await supabase
        .from("subscriptions")
        .update({ minutes_used: (parseFloat(sub.minutes_used) || 0) + minutesUsed })
        .eq("org_id", orgId);
    }
  }

  res.status(200).send("ok");
});

/* -----------------------------------------------------------
   GET /api/calls/:externalCallId
   Poll a call's current status (useful for live UI updates
   before the webhook fires, or if you're not using websockets).
----------------------------------------------------------- */
app.get("/api/calls/:externalCallId", async (req, res) => {
  try {
    const retellRes = await fetch(`https://api.retellai.com/v2/get-call/${req.params.externalCallId}`, {
      headers: { Authorization: `Bearer ${RETELL_API_KEY}` },
    });
    const text = await retellRes.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }

    if (!retellRes.ok) {
      return res.status(retellRes.status).json({ error: "Could not fetch call", detail: text.slice(0, 200) });
    }

    // Turn Retell's transcript into a simple list the UI can render.
    // transcript_object is an array of { role, content } once available.
    const turns = Array.isArray(data.transcript_object)
      ? data.transcript_object.map((t) => ({
          role: t.role === "agent" ? "agent" : "contact",
          text: t.content || "",
        }))
      : [];

    res.json({
      call_id: data.call_id,
      status: data.call_status,            // registered | ongoing | ended | error
      disconnection_reason: data.disconnection_reason || null,
      duration_seconds: data.duration_ms ? Math.round(data.duration_ms / 1000) : 0,
      turns,
      recording_url: data.recording_url || null,
    });
  } catch (err) {
    res.status(500).json({ error: "Could not fetch call status" });
  }
});

registerSiteBuilderRoutes(app, supabase);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Threshold backend running on port ${PORT}`));
