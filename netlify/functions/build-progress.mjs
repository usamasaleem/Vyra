import { getStore } from "@netlify/blobs";

const STORE = "vyra-build-plan";
const KEY = "shared-progress-v1";
const STEP_COUNTS = [4, 8, 7, 9, 4, 4];

function json(data, status = 200) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function validStep(id) {
  const match = /^p([0-5])s(\d+)$/.exec(id);
  return Boolean(match && Number(match[2]) < STEP_COUNTS[Number(match[1])]);
}

function cleanSteps(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {};
  return Object.fromEntries(
    Object.entries(input).filter(([id, checked]) => validStep(id) && checked === true),
  );
}

function payload(entry) {
  return {
    exists: entry !== null,
    steps: cleanSteps(entry?.data?.steps),
    updatedAt: entry?.data?.updatedAt ?? null,
  };
}

export default async function handler(request) {
  if (request.method !== "GET" && request.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const store = getStore({ name: STORE, consistency: "strong" });
    if (request.method === "GET") {
      return json(payload(await store.getWithMetadata(KEY, { type: "json" })));
    }

    const raw = await request.text();
    if (raw.length > 4096) return json({ error: "Request is too large." }, 413);
    let body;
    try { body = JSON.parse(raw); }
    catch { return json({ error: "Invalid JSON." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Invalid request." }, 400);
    }
    if (!["set", "clear", "import", "merge"].includes(body.action)) {
      return json({ error: "Invalid action." }, 400);
    }
    if (body.action === "set" && (!validStep(body.id) || typeof body.checked !== "boolean")) {
      return json({ error: "Invalid step." }, 400);
    }
    if ((body.action === "import" || body.action === "merge") &&
        (!body.steps || typeof body.steps !== "object" || Array.isArray(body.steps))) {
      return json({ error: "Invalid steps." }, 400);
    }

    if (body.action === "import") {
      const record = { steps: cleanSteps(body.steps), updatedAt: new Date().toISOString() };
      const result = await store.setJSON(KEY, record, { onlyIfNew: true });
      if (result.modified) return json({ exists: true, ...record });
      return json(payload(await store.getWithMetadata(KEY, { type: "json" })));
    }

    for (let attempt = 0; attempt < 8; attempt++) {
      const entry = await store.getWithMetadata(KEY, { type: "json" });
      const steps = cleanSteps(entry?.data?.steps);
      if (body.action === "clear") {
        for (const id of Object.keys(steps)) delete steps[id];
      } else if (body.action === "set") {
        if (body.checked) steps[body.id] = true;
        else delete steps[body.id];
      } else {
        Object.assign(steps, cleanSteps(body.steps));
      }
      const record = { steps, updatedAt: new Date().toISOString() };
      const result = await store.setJSON(KEY, record, entry ? { onlyIfMatch: entry.etag } : { onlyIfNew: true });
      if (result.modified) return json({ exists: true, ...record });
    }
    return json({ error: "Progress changed at the same time. Please retry." }, 409);
  } catch {
    return json({ error: "Shared progress is temporarily unavailable." }, 503);
  }
}
