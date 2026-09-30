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
  
  // Now makemodel is the only strictly required parameter. 
  // If icaos is empty, we do a GLOBAL SEARCH.
  if (!makemodel) {
    return { statusCode: 400, body: JSON.stringify({ error: "Aircraft Make/Model is required" }) };
  }

  try {
    // 1. Fetch aircraft config to check capacity (Seats/Weight)
    const confUrl = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=aircraft&search=configs`;
    const confRes = await executeQuery(confUrl);
    const confList = parseFseXml(confRes.raw, "AircraftConfig");
    const config = confList.find(c => c.MakeModel === makemodel);
    
    const seats = config ? parseInt(config.Seats) || 0 : 0;
    const mtow = config ? parseFloat(config.MTOW) || 0 : 0;
    const empty = config ? parseFloat(config.EmptyWeight) || 0 : 0;
    const maxPayload = mtow - empty;

    let origins = [];
    const aircraftAvailable = {}; // ICAO -> Array of rentable registrations

    if (icaos && icaos.trim()) {
      // MODE 1: Specific ICAOs provided
      origins = icaos.split("-").map(s => s.trim().toUpperCase()).filter(Boolean);
      
      // Fetch aircraft individually for these origins
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
      origins = origins.filter(icao => aircraftAvailable[icao]);

    } else {
      // MODE 2: GLOBAL SEARCH
      // Search aircraft globally by makemodel
      const acUrl = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=aircraft&search=makemodel&makemodel=${encodeURIComponent(makemodel)}`;
      const acRes = await executeQuery(acUrl);
      const acList = parseFseXml(acRes.raw, "Aircraft");

      for (const a of acList) {
        const dry = parseFloat(a.RentalDry) || 0;
        const wet = parseFloat(a.RentalWet) || 0;
        const isRentable = dry > 0 || wet > 0;
        
        if (!rentableOnly || isRentable) {
          const icao = a.Location;
          if (icao && icao !== "In Flight") {
            if (!aircraftAvailable[icao]) aircraftAvailable[icao] = [];
            aircraftAvailable[icao].push(a.Registration);
          }
        }
      }
      origins = Object.keys(aircraftAvailable);
    }

    if (origins.length === 0) {
      return { statusCode: 200, body: JSON.stringify({ matches: [] }) };
    }

    // 2. Fetch jobs from the matched origins
    // FSE allows multiple ICAOs for jobsfrom. We chunk them to reduce API calls and avoid 10s timeout.
    const chunkSize = 100; 
    let allJobs = [];
    
    for (let i = 0; i < origins.length; i += chunkSize) {
      const chunk = origins.slice(i, i + chunkSize);
      const chunkIcaos = chunk.join("-");
      const jobsUrl = `${baseUrl}?userkey=${encodeURIComponent(userKey)}&format=xml&query=icao&search=jobsfrom&icaos=${encodeURIComponent(chunkIcaos)}`;
      const jobsRes = await executeQuery(jobsUrl);
      const chunkJobs = parseFseXml(jobsRes.raw, "Job");
      allJobs = allJobs.concat(chunkJobs);
    }

    // 3. Filter jobs by commodity and capacity
    const commodityLower = (commodity || "").toLowerCase();
    
    const finalJobs = allJobs.filter(j => {
      if (commodityLower && !(j.Commodity || "").toLowerCase().includes(commodityLower)) return false;
      
      const amount = parseFloat(j.Amount) || 0;
      const unit = (j.UnitType || "").toLowerCase();
      
      if (unit === "passengers" && seats > 0 && amount > seats) return false;
      if (unit === "kg" && maxPayload > 0 && amount > maxPayload) return false;
      
      return true;
    });

    // 4. Format results
    const results = finalJobs.map(j => {
      const pay = parseFloat(j.Pay) || 0;
      const distance = parseFloat(j.Distance) || 0;
      const payPerNm = distance > 0 ? (pay / distance) : 0;
      
      return {
        Origin: j.Location,
        Destination: j.ToIcao,
        Commodity: j.Commodity,
        Amount: `${j.Amount} ${j.UnitType}`,
        Distance: distance > 0 ? distance : "?",
        Pay: pay,
        "Pay/NM": parseFloat(payPerNm.toFixed(2)),
        Aeronaves: aircraftAvailable[j.Location] ? aircraftAvailable[j.Location].join(", ") : ""
      };
    });

    // Sort by Pay/NM descending by default
    results.sort((a, b) => (b["Pay/NM"] || 0) - (a["Pay/NM"] || 0));

    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ 
        matches: results, 
        aircraftConfig: { seats, maxPayload }, 
        locationsCount: origins.length 
      }),
    };

  } catch (error) {
    return {
      statusCode: 502,
      body: JSON.stringify({ error: error.message }),
    };
  }
};
