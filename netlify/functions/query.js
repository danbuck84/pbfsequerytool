const { queries, publicQueryDefinition } = require("../../src/queries");
const { buildUrl, redactUrl, executeQuery } = require("../../src/fseApi");

const baseUrl = process.env.FSE_BASE_URL || "https://server.fseconomy.net/data";

function sendJson(statusCode, payload) {
  return {
    statusCode,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify(payload),
  };
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") {
    return sendJson(405, { error: "Method not allowed" });
  }

  let body;
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return sendJson(400, { error: "Invalid JSON body." });
  }

  const { queryId, params = {} } = body;
  const definition = queries.find((item) => item.id === queryId);
  if (!definition) {
    return sendJson(400, { error: "Unknown query type." });
  }

  let requestUrl;
  try {
    requestUrl = buildUrl({
      baseUrl,
      userKey: process.env.FSE_USER_KEY,
      readAccessKey: process.env.FSE_READ_ACCESS_KEY,
      definition,
      params,
    });
  } catch (error) {
    return sendJson(400, { error: error.message });
  }

  try {
    const { raw } = await executeQuery(requestUrl);
    return sendJson(200, {
      query: publicQueryDefinition(definition),
      requestUrl: redactUrl(requestUrl),
      raw,
    });
  } catch (error) {
    return sendJson(error.statusCode || 502, {
      error: error.message,
      requestUrl: redactUrl(requestUrl),
      raw: error.raw || undefined,
    });
  }
};
