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

// Explicitly answer preflight for every route.
app.options(/.*/, cors());

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
   POST /api/calls/start
   Body: { orgId, leadId, leadName, leadNumber, businessName }
   Places a real outbound call via Retell AI, using the lead's
   business info as dynamic variables the agent can reference.
----------------------------------------------------------- */
app.post("/api/calls/start", async (req, res) => {
  const { orgId, leadId, leadName, leadNumber, businessName } = req.body;

  if (!orgId || !leadId || !leadNumber) {
    return res.status(400).json({ error: "orgId, leadId, and leadNumber are required" });
  }

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
        from_number: RETELL_FROM_NUMBER,
        to_number: leadNumber,
        override_agent_id: RETELL_AGENT_ID,
        retell_llm_dynamic_variables: {
          lead_name: leadName || "there",
          business_name: businessName || "your business",
        },
        metadata: { orgId, leadId }, // comes back on the webhook so we know which lead/org this call belongs to
      }),
    });

    const retellData = await retellRes.json();

    if (!retellRes.ok) {
      return res.status(502).json({ error: "Retell call failed", details: retellData });
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
    const data = await retellRes.json();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: "Could not fetch call status" });
  }
});

registerSiteBuilderRoutes(app, supabase);

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`Threshold backend running on port ${PORT}`));
