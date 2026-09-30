function validateField(field, value) {
  const normalized = value === undefined || value === null ? "" : String(value).trim();

  if (field.required && !normalized) {
    throw new Error(`Field \"${field.label}\" is required.`);
  }

  if (!normalized) return null;

  if (field.type === "number") {
    const numeric = Number(normalized);
    if (!Number.isFinite(numeric)) {
      throw new Error(`Field \"${field.label}\" must be a number.`);
    }
    if (field.min !== undefined && numeric < field.min) {
      throw new Error(`Field \"${field.label}\" must be at least ${field.min}.`);
    }
    if (field.max !== undefined && numeric > field.max) {
      throw new Error(`Field \"${field.label}\" must be at most ${field.max}.`);
    }
  }

  return normalized;
}

function buildUrl({ baseUrl, userKey, readAccessKey, definition, params }) {
  if (!userKey) {
    throw new Error("FSE_USER_KEY is not configured on the server.");
  }
  if (definition.needsReadAccessKey && !readAccessKey) {
    throw new Error("This query requires FSE_READ_ACCESS_KEY, but it is not configured on the server.");
  }

  const url = new URL(baseUrl);
  url.searchParams.set("userkey", userKey);
  url.searchParams.set("format", "xml");
  url.searchParams.set("query", definition.query);
  url.searchParams.set("search", definition.search);

  if (definition.needsReadAccessKey) {
    url.searchParams.set("readaccesskey", readAccessKey);
  }

  for (const [key, value] of Object.entries(definition.fixedParams || {})) {
    url.searchParams.set(key, value);
  }

  for (const flag of definition.flagParams || []) {
    url.searchParams.set(flag, "");
  }

  for (const field of definition.fields) {
    const value = validateField(field, params?.[field.name]);
    if (value !== null) {
      url.searchParams.set(field.name, value);
    }
  }

  let finalUrl = url.toString();
  for (const flag of definition.flagParams || []) {
    finalUrl = finalUrl.replace(`${encodeURIComponent(flag)}=`, encodeURIComponent(flag));
  }

  return finalUrl;
}

function redactUrl(urlString) {
  const url = new URL(urlString);
  if (url.searchParams.has("userkey")) url.searchParams.set("userkey", "***");
  if (url.searchParams.has("readaccesskey")) url.searchParams.set("readaccesskey", "***");
  return url.toString().replace(/archive=/g, "archive");
}

async function executeQuery(urlString) {
  const response = await fetch(urlString, {
    headers: {
      "User-Agent": "fse-query-tool/0.1",
      Accept: "application/xml,text/xml;q=0.9,*/*;q=0.8",
    },
  });

  const raw = await response.text();

  if (!response.ok) {
    const error = new Error(`FSEconomy returned HTTP ${response.status}.`);
    error.statusCode = response.status;
    error.raw = raw;
    throw error;
  }

  return { raw };
}

module.exports = {
  buildUrl,
  redactUrl,
  executeQuery,
};
// Note: Node.js does not have DOMParser built-in. We can't use browser DOMParser in Netlify Functions easily without a library.
// For the matcher function, it's better to implement a simple regex-based XML parser or just use a lightweight one.
// Let's modify the matcher function instead to not rely on DOMParser.
