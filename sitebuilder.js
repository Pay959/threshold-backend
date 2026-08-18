// Threshold — AI website builder
// Takes a lead's business info, generates a real single-page site with Claude,
// and deploys it live to Vercel via their API. Add this route to server.js.

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN;
const VERCEL_TEAM_ID = process.env.VERCEL_TEAM_ID; // optional, only if deploying under a team
const NETLIFY_TOKEN = process.env.NETLIFY_TOKEN;

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

Output the raw HTML only.

CRITICAL OUTPUT RULES:
- Your entire response must be a single HTML document
- Start with <!DOCTYPE html> as the very first characters
- End with </html> as the very last characters
- Do NOT wrap it in markdown code fences
- Do NOT write any explanation before or after
- Do NOT say "Here is your website" or anything similar`;

  if (!ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY is not set in Railway Variables.");
  }

  // Try current models in order — if one isn't available on this account, fall back.
  const models = ["claude-sonnet-4-5", "claude-sonnet-4-20250514", "claude-3-5-sonnet-20241022"];
  let lastError = "";

  for (const model of models) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8000,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = {}; }

    if (!res.ok) {
      const msg = (data.error && data.error.message) || text.slice(0, 300);
      lastError = `${model}: ${msg}`;
      console.error("Claude call failed:", res.status, lastError);
      // Credit/auth problems won't be fixed by trying another model
      if (res.status === 401 || res.status === 403) {
        throw new Error(`Anthropic rejected the API key. ${msg}`);
      }
      if (msg.toLowerCase().includes("credit") || msg.toLowerCase().includes("balance")) {
        throw new Error(`Anthropic account has no credits. Add credits at console.anthropic.com. (${msg})`);
      }
      continue; // try the next model
    }

    const textBlock = (data.content || []).find((b) => b.type === "text");
    let html = textBlock ? textBlock.text : "";

    // Claude sometimes wraps output in markdown fences or adds a sentence
    // before/after. Extract just the HTML document itself.
    html = html.trim();

    // Strip any markdown code fences anywhere in the response
    html = html.replace(/```[a-zA-Z]*\n?/g, "").replace(/```/g, "");

    // Find the real start of the document and cut everything before it
    const doctypeIdx = html.search(/<!DOCTYPE\s+html/i);
    const htmlTagIdx = html.search(/<html[\s>]/i);
    const startIdx = doctypeIdx >= 0 ? doctypeIdx : htmlTagIdx;
    if (startIdx > 0) html = html.slice(startIdx);

    // Cut anything after the closing tag
    const endIdx = html.toLowerCase().lastIndexOf("</html>");
    if (endIdx >= 0) html = html.slice(0, endIdx + 7);

    html = html.trim();

    // If Claude returned a fragment without <html>, wrap it so browsers render it
    if (html && !/<html[\s>]/i.test(html)) {
      html = `<!DOCTYPE html>\n<html lang="en">\n<head>\n<meta charset="UTF-8">\n<meta name="viewport" content="width=device-width, initial-scale=1.0">\n<title>${business.name}</title>\n</head>\n<body>\n${html}\n</body>\n</html>`;
    }

    if (!html || !/<html[\s>]/i.test(html)) {
      lastError = `${model}: response didn't contain valid HTML`;
      continue;
    }

    console.log(`Site generated with ${model}, ${html.length} chars, starts with: ${html.slice(0, 60)}`);
    return html;
  }

  throw new Error(`All models failed. Last error — ${lastError}`);
}

/* -----------------------------------------------------------
   Deploys the generated HTML as a static site to Vercel.
   Returns the live URL.
----------------------------------------------------------- */
/* -----------------------------------------------------------
   Deploys the generated HTML to Netlify.
   Netlify's API is more permissive than Vercel's for programmatic
   site creation, so this is the default when NETLIFY_TOKEN is set.
----------------------------------------------------------- */
async function deployToNetlify(slug, html) {
  if (!NETLIFY_TOKEN) {
    throw new Error("NETLIFY_TOKEN is not set in Railway Variables.");
  }

  // 1. Create a new site
  const createRes = await fetch("https://api.netlify.com/api/v1/sites", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NETLIFY_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ name: slug }),
  });

  const createText = await createRes.text();
  let site;
  try { site = JSON.parse(createText); } catch { site = {}; }

  if (!createRes.ok) {
    console.error("Netlify site creation failed:", createRes.status, createText);
    const msg = site.message || createText.slice(0, 250);
    if (createRes.status === 401) {
      throw new Error(`Netlify rejected the token. Check NETLIFY_TOKEN in Railway. (${msg})`);
    }
    throw new Error(`Netlify site creation failed: ${msg}`);
  }

  // 2. Deploy the HTML as a zip containing index.html
  const zipBuffer = await makeSingleFileZip("index.html", html);

  const deployRes = await fetch(`https://api.netlify.com/api/v1/sites/${site.id}/deploys`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${NETLIFY_TOKEN}`,
      "Content-Type": "application/zip",
    },
    body: zipBuffer,
  });

  const deployText = await deployRes.text();
  if (!deployRes.ok) {
    console.error("Netlify deploy failed:", deployRes.status, deployText);
    throw new Error(`Netlify deploy failed: ${deployText.slice(0, 250)}`);
  }

  return site.ssl_url || site.url || `https://${site.name}.netlify.app`;
}

/* Build a minimal zip in memory containing one file.
   Netlify accepts a zip upload for deploys. */
function makeSingleFileZip(filename, content) {
  const zlib = require("zlib");
  const nameBuf = Buffer.from(filename, "utf8");
  const dataBuf = Buffer.from(content, "utf8");
  const deflated = zlib.deflateRawSync(dataBuf);

  const crcTable = (() => {
    const table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();

  let crc = 0xffffffff;
  for (const b of dataBuf) crc = crcTable[(crc ^ b) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;

  const localHeader = Buffer.alloc(30);
  localHeader.writeUInt32LE(0x04034b50, 0);
  localHeader.writeUInt16LE(20, 4);
  localHeader.writeUInt16LE(0, 6);
  localHeader.writeUInt16LE(8, 8);
  localHeader.writeUInt16LE(0, 10);
  localHeader.writeUInt16LE(0, 12);
  localHeader.writeUInt32LE(crc, 14);
  localHeader.writeUInt32LE(deflated.length, 18);
  localHeader.writeUInt32LE(dataBuf.length, 22);
  localHeader.writeUInt16LE(nameBuf.length, 26);
  localHeader.writeUInt16LE(0, 28);

  const centralHeader = Buffer.alloc(46);
  centralHeader.writeUInt32LE(0x02014b50, 0);
  centralHeader.writeUInt16LE(20, 4);
  centralHeader.writeUInt16LE(20, 6);
  centralHeader.writeUInt16LE(0, 8);
  centralHeader.writeUInt16LE(8, 10);
  centralHeader.writeUInt16LE(0, 12);
  centralHeader.writeUInt16LE(0, 14);
  centralHeader.writeUInt32LE(crc, 16);
  centralHeader.writeUInt32LE(deflated.length, 20);
  centralHeader.writeUInt32LE(dataBuf.length, 24);
  centralHeader.writeUInt16LE(nameBuf.length, 28);
  centralHeader.writeUInt16LE(0, 30);
  centralHeader.writeUInt16LE(0, 32);
  centralHeader.writeUInt16LE(0, 34);
  centralHeader.writeUInt16LE(0, 36);
  centralHeader.writeUInt32LE(0, 38);
  centralHeader.writeUInt32LE(0, 42);

  const localPart = Buffer.concat([localHeader, nameBuf, deflated]);
  const centralPart = Buffer.concat([centralHeader, nameBuf]);

  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);
  endRecord.writeUInt16LE(0, 4);
  endRecord.writeUInt16LE(0, 6);
  endRecord.writeUInt16LE(1, 8);
  endRecord.writeUInt16LE(1, 10);
  endRecord.writeUInt32LE(centralPart.length, 12);
  endRecord.writeUInt32LE(localPart.length, 16);
  endRecord.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, endRecord]);
}

async function deployToVercel(slug, html) {
  if (!VERCEL_TOKEN) {
    throw new Error("VERCEL_TOKEN is not set in Railway Variables.");
  }

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

  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }

  if (!res.ok) {
    const msg = (data.error && (data.error.message || data.error.code)) || text.slice(0, 300);
    console.error("Vercel deploy failed:", res.status, text);
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Vercel rejected the token. Check VERCEL_TOKEN in Railway. (${msg})`);
    }
    throw new Error(`Vercel deploy failed: ${msg}`);
  }

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

      // Prefer Netlify if a token is set — its API is more permissive
      // for programmatic site creation. Fall back to Vercel otherwise.
      const liveUrl = NETLIFY_TOKEN
        ? await deployToNetlify(slug, html)
        : await deployToVercel(slug, html);

      await supabase
        .from("generated_sites")
        .update({ site_url: liveUrl, status: "live" })
        .eq("id", siteRow.id);

      res.json({ success: true, url: liveUrl, siteId: siteRow.id });
    } catch (err) {
      console.error("Site generation error:", err);
      res.status(500).json({ error: err.message || "Site generation failed" });
    }
  });
}

module.exports = { registerSiteBuilderRoutes, generateSiteHTML, deployToVercel };
