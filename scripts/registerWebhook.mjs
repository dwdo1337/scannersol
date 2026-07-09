// One-off script: registers (or updates) a Helius Enhanced Webhook pointed
// at the deployed Render URL. Run manually after deploying, once you know
// the live URL: node scripts/registerWebhook.mjs https://your-app.onrender.com
//
// Program IDs match feed.ts's narrowing rationale - Pump.fun + PumpSwap
// only, since that's overwhelmingly where fresh-wallet sniping happens.
import 'dotenv/config';

const PUMPFUN = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';

const heliusKey = process.env.HELIUS_KEY_3;
const webhookSecret = process.env.WEBHOOK_SECRET;
const baseUrl = process.argv[2];

if (!heliusKey) throw new Error('HELIUS_KEY_1 missing in .env');
if (!webhookSecret) throw new Error('WEBHOOK_SECRET missing in .env');
if (!baseUrl) throw new Error('Usage: node scripts/registerWebhook.mjs https://your-app.onrender.com');

const webhookUrl = `${baseUrl.replace(/\/$/, '')}/webhook/${webhookSecret}`;

const res = await fetch(`https://api.helius.xyz/v0/webhooks?api-key=${heliusKey}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    webhookURL: webhookUrl,
    transactionTypes: ['SWAP'],
    accountAddresses: [PUMPFUN, PUMPSWAP],
    webhookType: 'enhanced',
    txnStatus: 'success',
  }),
});

const body = await res.json();
console.log('status:', res.status);
console.log(JSON.stringify(body, null, 2));

if (res.ok) {
  console.log('\nWebhook registered pointing at:', webhookUrl);
  console.log('Save the returned "webhookID" - you will need it to update/delete this webhook later.');
} else {
  console.log('\nRegistration failed - check the response above.');
}
