const { handler } = require('./netlify/functions/matcher');

process.env.FSE_USER_KEY = '93CEEA67F01C078A';

async function run() {
  const event = {
    httpMethod: 'POST',
    body: JSON.stringify({
      icaos: 'SBBU',
      commodity: '',
      makemodel: '',
      rentableOnly: false
    })
  };

  const res = await handler(event);
  console.log(res.statusCode);
  console.log(JSON.parse(res.body));
}

run();
