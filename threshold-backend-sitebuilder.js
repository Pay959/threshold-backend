// Threshold — AI website builder
// Takes a lead's business info, generates a real single-page site with Claude,
// and deploys it live to Vercel via their API. Add this route to server.js.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID; // optional, only if deploying under a team

/* -----------------------------------------------------------
   Generates a single-file HTML site for a business using Claude,
   based on whatever info is on the lead (business name, category,
   notes, business_info jsonb blob with address/industry/etc).
----------------------------------------------------------- */
async function generateSiteHTML(business) {
  const prompt = `You are building a real, professional single-page marketing website for a small local business. Output ONLY complete, valid HTML (no markdown fences, no explanation before or after) — a single self-contained HTML file with inline <style> CSS, no external dependencies except Google Fonts if you want.

Business name: ${business.name}
Category/industry: ${business.category || "local business"}
Notes / extra info: ${business.notes || "none provided"}
Additional details: ${JSON.stringify(business.info || {})}

Requirements:
- Modern, clean, mobile-responsive design
- Hero section with the business name and a compelling one-line value proposition
- A short "About" section
- A "Services" or "What we offer" section (infer 3-4 reasonable services from the business type if not specified)
- A contact section with a call-to-action (phone number if provided, otherwise a generic "Call us" prompt)
- Real, tasteful color palette and typography — not generic Bootstrap defaults
- No placeholder "lorem ipsum" — write real, specific-sounding copy for this business

Output the raw HTML only.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 4000,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error("Claude generation failed: " + JSON.stringify(data));

  const textBlock = data.content.find((b) => b.type === "text");
  let html = textBlock ? textBlock.text : "";

  // Strip markdown fences if Claude added them despite instructions
  html = html.replace(/^```html\n?/, "").replace(/```$/, "").trim();

  return html;
}

/* -----------------------------------------------------------
   Deploys the generated HTML as a static site to Vercel.
   Returns the live URL.
----------------------------------------------------------- */
async function deployToVercel(slug, html) {
  const teamQuery = VERCEL_TEAM_ID ? `?teamId=${VERCEL_TEAM_ID}` : "";

  const res = await fetch(`https://api.vercel.com/v13/deployments${teamQuery}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${VERCEL_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      name: slug,
      target: "production",
      files: [
        {
          file: "index.html",
          data: Buffer.from(html).toString("base64"),
          encoding: "base64",
        },
      ],
      projectSettings: {
        framework: null,
      },
    }),
  });

  const data = await res.json();
  if (!res.ok) throw new Error("Vercel deploy failed: " + JSON.stringify(data));

  // data.url is something like "slug-xxxxx.vercel.app"
  return `https://${data.url}`;
}

/* -----------------------------------------------------------
   POST /api/sites/generate
   Body: { orgId, leadId, businessName, category, notes, info }
----------------------------------------------------------- */
function registerSiteBuilderRoutes(app, supabase) {
  app.post("/api/sites/generate", async (req, res) => {
    const { orgId, leadId, businessName, category, notes, info } = req.body;

    if (!orgId || !businessName) {
      return res.status(400).json({ error: "orgId and businessName are required" });
    }

    try {
      // Check the org has the site builder unlocked
      const { data: sub } = await supabase
        .from("subscriptions")
        .select("site_builder_unlocked")
        .eq("org_id", orgId)
        .single();
      const { data: org } = await supabase
        .from("organizations")
        .select("is_platform_owner")
        .eq("id", orgId)
        .single();

      if (!org?.is_platform_owner && !sub?.site_builder_unlocked) {
        return res.status(402).json({ error: "AI website builder is not unlocked for this account" });
      }

      // Insert a "generating" row immediately so the UI can show progress
      const { data: siteRow } = await supabase
        .from("generated_sites")
        .insert({ org_id: orgId, lead_id: leadId, business_name: businessName, status: "generating" })
        .select()
        .single();

      const html = await generateSiteHTML({ name: businessName, category, notes, info });

      const slug = `${businessName}-${siteRow.id}`
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "")
        .slice(0, 50);

      const liveUrl = await deployToVercel(slug, html);

      await supabase
        .from("generated_sites")
        .update({ site_url: liveUrl, status: "live" })
        .eq("id", siteRow.id);

      res.json({ success: true, url: liveUrl, siteId: siteRow.id });
    } catch (err) {
      console.error("Site generation error:", err);
      res.status(500).json({ error: "Site generation failed", details: err.message });
    }
  });
}

module.exports = { registerSiteBuilderRoutes, generateSiteHTML, deployToVercel };
