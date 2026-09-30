const { executeQuery } = require("../../src/fseApi");

const baseUrl = process.env.FSE_BASE_URL || "https://server.fseconomy.net/data";

function parseFseXml(xml, itemTag) {
  const results = [];
  const regex = new RegExp(`<${itemTag}>([\\s\\S]*?)</${itemTag}>`, 'g');
  let match;
  while ((match = regex.exec(xml)) !== null) {
    const itemXml = match[1];
    const item = {};
    const propRegex = /<([a-zA-Z0-9]+)>([^<]*)<\/\1>/g;
    let propMatch;
    while ((propMatch = propRegex.exec(itemXml)) !== null) {
      item[propMatch[1]] = propMatch[2].trim();
    }
    results.push(item);
  }
  return results;
}

exports.handler = async (event) => {
  if (event.httpMethod !== "POST") return { statusCode: 405, body: "Method not allowed" };

  const userKey = process.env.FSE_USER_KEY;
  if (!userKey) return { statusCode: 500, body: JSON.stringify({ error: "FSE_USER_KEY not configured" }) };

  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, body: JSON.stringify({ error: "Invalid JSON" }) };
  }

  const { icaos, commodity, makemodel, rentableOnly } = body;
  if (!icaos || !makemodel) {
    return { statusCode: 400, body: JSON.stringify({ error: "Missing required fields (icaos, makemodel)" }) };
  }

  try {
    // 1. Fetch jobs from the provided ICAOs
    const jobsUrl = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=icao&search=jobsfrom&icaos=${encodeURIComponent(icaos)}`;
    const jobsRes = await executeQuery(jobsUrl);
    const allJobs = parseFseXml(jobsRes.raw, "Job");

    // 2. Filter jobs by commodity
    const commodityLower = (commodity || "").toLowerCase();
    const matchedJobs = allJobs.filter(j => (j.Commodity || "").toLowerCase().includes(commodityLower));

    if (matchedJobs.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ matches: [] }) };
    }

    // 3. Find unique origin ICAOs from the matched jobs
    const origins = [...new Set(matchedJobs.map(j => j.Location))];

    // 4. Check aircraft availability at those origins
    const aircraftAvailable = {}; // ICAO -> Array of rentable registrations
    for (const icao of origins) {
      const acUrl = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=icao&search=aircraft&icao=${encodeURIComponent(icao)}`;
      const acRes = await executeQuery(acUrl);
      const acList = parseFseXml(acRes.raw, "Aircraft");
      
      const rentableOfModel = acList.filter(a => {
        const isModel = a.MakeModel === makemodel;
        const dry = parseFloat(a.RentalDry) || 0;
        const wet = parseFloat(a.RentalWet) || 0;
        const isRentable = dry > 0 || wet > 0;
        return isModel && (!rentableOnly || isRentable);
      });
      
      if (rentableOfModel.length > 0) {
        aircraftAvailable[icao] = rentableOfModel.map(a => a.Registration);
      }
    }

    // 5. Fetch aircraft config to check capacity (Seats/Weight)
    const confUrl = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=aircraft&search=configs`;
    const confRes = await executeQuery(confUrl);
    const confList = parseFseXml(confRes.raw, "AircraftConfig");
    const config = confList.find(c => c.MakeModel === makemodel);
    
    const seats = config ? parseInt(config.Seats) || 0 : 0;
    // Rough payload calc: MTOW - EmptyWeight
    const mtow = config ? parseFloat(config.MTOW) || 0 : 0;
    const empty = config ? parseFloat(config.EmptyWeight) || 0 : 0;
    const maxPayload = mtow - empty;

    // 6. Filter final jobs: origin must have aircraft, and capacity must fit
    const finalJobs = matchedJobs.filter(j => {
      // Must have aircraft available
      if (!aircraftAvailable[j.Location]) return false;
      
      const amount = parseFloat(j.Amount) || 0;
      const unit = (j.UnitType || "").toLowerCase();
      
      // Capacity check
      if (unit === "passengers" && seats > 0) {
        if (amount > seats) return false;
      } else if (unit === "kg" && maxPayload > 0) {
        if (amount > maxPayload) return false;
      }
      
      return true;
    });

    // 7. Format results
    const results = finalJobs.map(j => ({
      Origin: j.Location,
      Destination: j.ToIcao,
      Commodity: j.Commodity,
      Amount: `${j.Amount} ${j.UnitType}`,
      Pay: parseFloat(j.Pay) || 0,
      Aeronaves: aircraftAvailable[j.Location].join(", ")
    }));

    // Sort by pay descending by default
    results.sort((a, b) => b.Pay - a.Pay);

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ matches: results, aircraftConfig: { seats, maxPayload } }),
    };

  } catch (error) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
