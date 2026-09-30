const { executeQuery } = require("../../src/fseApi");

const baseUrl = process.env.FSE_BASE_URL || "https://server.fseconomy.net/data";

exports.handler = async () => {
  const userKey = process.env.FSE_USER_KEY;
  if (!userKey) {
    return {
      statusCode: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: "FSE_USER_KEY not configured", models: [] }),
    };
  }

  try {
    const url = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=aircraft&search=configs`;
    const { raw } = await executeQuery(url);

    const models = new Set();
    const regex = /<MakeModel>([^<]+)<\/MakeModel>/g;
    let match;
    while ((match = regex.exec(raw)) !== null) {
      models.add(match[1].trim());
    }

    const sorted = [...models].sort((a, b) => a.localeCompare(b));

    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
      body: JSON.stringify({ models: sorted }),
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ error: error.message, models: [] }),
    };
  }
};
