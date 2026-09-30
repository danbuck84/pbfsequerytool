const { queries, publicQueryDefinition } = require("../../src/queries");

exports.handler = async () => {
  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
    body: JSON.stringify({
      ok: true,
      userKeyConfigured: Boolean(process.env.FSE_USER_KEY),
      readAccessKeyConfigured: Boolean(process.env.FSE_READ_ACCESS_KEY),
    }),
  };
};
