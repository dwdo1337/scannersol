// Token-side safety data: mint/freeze authority, holder concentration,
// liquidity, and token age. This is the piece "fresh wallet bought
// something" was missing - without it every alert looks the same whether
// the token is a locked, renounced launch or an obvious rug in progress.
//
// Sources:
// - mint/freeze authority + supply: Solana RPC getAccountInfo (mint account,
//   SPL Token program layout) via the existing Helius RPC pool - no extra
//   API/key needed.
// - top holder concentration: getTokenLargestAccounts (same RPC pool).
// - liquidity/fdv/pair age: DexScreener public API (no key required) -
//   keyed by mint, picks the highest-liquidity pair if several exist.
import { rpcCall } from './rpcPool.js';

export interface TokenSafety {
  mintRevoked: boolean | null;   // mint authority == null
  freezeRevoked: boolean | null; // freeze authority == null
  topHolderPct: number | null;   // sum of top 10 holder balances / supply, %
  devHolderPct: number | null;   // best-effort: largest single non-LP holder %
  liquidityUsd: number | null;
  tokenAgeSec: number | null;
  solPriceUsd: number | null;
}

const cache = new Map<string, { data: TokenSafety; expires: number }>();
const TTL_MS = 2 * 60 * 1000; // 2min - token state changes fast right after launch

// SPL Token mint account layout: authorities are optional COption<Pubkey>
// each stored as a 4-byte tag (1 = present) followed by 32 bytes if present.
// Layout (post header): mintAuthorityOption(4) mintAuthority(32)
// supply(8) decimals(1) isInitialized(1) freezeAuthorityOption(4) freezeAuthority(32)
function parseMintAccount(base64Data: string): { mintRevoked: boolean; freezeRevoked: boolean; supply: bigint; decimals: number } | null {
  try {
    const buf = Buffer.from(base64Data, 'base64');
    if (buf.length < 82) return null;
    const mintAuthorityOption = buf.readUInt32LE(0);
    const supply = buf.readBigUInt64LE(36);
    const decimals = buf.readUInt8(44);
    const freezeAuthorityOption = buf.readUInt32LE(46);
    return {
      mintRevoked: mintAuthorityOption === 0,
      freezeRevoked: freezeAuthorityOption === 0,
      supply,
      decimals,
    };
  } catch {
    return null;
  }
}

async function fetchMintAuthorities(mint: string) {
  const res = await rpcCall<any>('getAccountInfo', [mint, { encoding: 'base64' }]);
  const raw = res?.value?.data?.[0];
  if (!raw) return null;
  return parseMintAccount(raw);
}

async function fetchTopHolderPct(mint: string, totalSupply: bigint): Promise<number | null> {
  if (totalSupply === 0n) return null;
  const res = await rpcCall<any>('getTokenLargestAccounts', [mint]);
  const accounts: any[] = res?.value ?? [];
  if (!accounts.length) return null;
  const top10 = accounts.slice(0, 10);
  let sum = 0n;
  for (const a of top10) {
    sum += BigInt(a.amount ?? '0');
  }
  return Number((sum * 10000n) / totalSupply) / 100;
}

async function fetchDevHolderPct(mint: string, totalSupply: bigint): Promise<number | null> {
  if (totalSupply === 0n) return null;
  const res = await rpcCall<any>('getTokenLargestAccounts', [mint]);
  const accounts: any[] = res?.value ?? [];
  if (!accounts.length) return null;
  // Best-effort proxy: the single largest holder is usually either the LP
  // vault or the dev/creator wallet. We can't cheaply distinguish LP vaults
  // from RPC alone without an extra program-account lookup, so this is
  // reported as "largest single holder %" - a real dev-wallet-exclusion
  // pass (checking against the pool's own vault addresses) is a follow-up.
  const largest = BigInt(accounts[0]?.amount ?? '0');
  return Number((largest * 10000n) / totalSupply) / 100;
}

async function fetchDexScreenerData(mint: string): Promise<{ liquidityUsd: number | null; tokenAgeSec: number | null; solPriceUsd: number | null }> {
  try {
    const res = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    if (!res.ok) return { liquidityUsd: null, tokenAgeSec: null, solPriceUsd: null };
    const body: any = await res.json();
    const pairs: any[] = body?.pairs ?? [];
    if (!pairs.length) return { liquidityUsd: null, tokenAgeSec: null, solPriceUsd: null };
    const best = pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a));
    const liquidityUsd = best.liquidity?.usd ?? null;
    const tokenAgeSec = best.pairCreatedAt ? (Date.now() - best.pairCreatedAt) / 1000 : null;
    // priceUsd is token price in USD, priceNative is token price in SOL (quote token) -
    // dividing recovers SOL/USD from the same pair with no extra request.
    const priceUsd = best.priceUsd ? Number(best.priceUsd) : null;
    const priceNative = best.priceNative ? Number(best.priceNative) : null;
    const solPriceUsd = priceUsd != null && priceNative && priceNative > 0 ? priceUsd / priceNative : null;
    return { liquidityUsd, tokenAgeSec, solPriceUsd };
  } catch {
    return { liquidityUsd: null, tokenAgeSec: null, solPriceUsd: null };
  }
}

export async function getTokenSafety(mint: string): Promise<TokenSafety> {
  const hit = cache.get(mint);
  if (hit && hit.expires > Date.now()) return hit.data;

  const empty: TokenSafety = {
    mintRevoked: null,
    freezeRevoked: null,
    topHolderPct: null,
    devHolderPct: null,
    liquidityUsd: null,
    tokenAgeSec: null,
    solPriceUsd: null,
  };

  try {
    const [mintInfo, dex] = await Promise.all([fetchMintAuthorities(mint), fetchDexScreenerData(mint)]);

    let topHolderPct: number | null = null;
    let devHolderPct: number | null = null;
    if (mintInfo) {
      [topHolderPct, devHolderPct] = await Promise.all([
        fetchTopHolderPct(mint, mintInfo.supply),
        fetchDevHolderPct(mint, mintInfo.supply),
      ]);
    }

    const data: TokenSafety = {
      mintRevoked: mintInfo?.mintRevoked ?? null,
      freezeRevoked: mintInfo?.freezeRevoked ?? null,
      topHolderPct,
      devHolderPct,
      liquidityUsd: dex.liquidityUsd,
      tokenAgeSec: dex.tokenAgeSec,
      solPriceUsd: dex.solPriceUsd,
    };
    cache.set(mint, { data, expires: Date.now() + TTL_MS });
    return data;
  } catch (err) {
    console.error('[tokenSafety] lookup failed for', mint, err);
    return empty;
  }
}
