import dns from 'node:dns';
import { startBot } from './bot.js';
import { startWebhookServer } from './webhookServer.js';

// This host's IPv6 route to Cloudflare (which fronts api.helius.xyz) is
// broken/unreachable, while IPv4 works fine. Helius's domain is dual-stack,
// so Node's fetch occasionally races into the dead IPv6 path and hits
// ConnectTimeoutError/ETIMEDOUT. Forcing IPv4-first resolution avoids that
// entirely instead of papering over it with more retries.
dns.setDefaultResultOrder('ipv4first');

console.log('freshieTG starting - webhook ingestion + persistence + filters + telegram bot');
startBot();
startWebhookServer();
