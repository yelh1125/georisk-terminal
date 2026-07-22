import Redis from 'ioredis';

let redis: Redis | null | undefined;
const memory = new Map<string, { value: string; expiresAt: number }>();

function client(): Redis | null {
  if (redis !== undefined) return redis;
  if (!process.env.REDIS_URL) {
    redis = null;
    return null;
  }
  redis = new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1, lazyConnect: true });
  redis.on('error', (error) => console.warn('[cache] Redis unavailable', error.message));
  return redis;
}

export async function getCache<T>(key: string): Promise<T | null> {
  const redisClient = client();
  try {
    const stored = redisClient ? await redisClient.get(key) : memory.get(key)?.value;
    return stored ? JSON.parse(stored) as T : null;
  } catch {
    const item = memory.get(key);
    return item && item.expiresAt > Date.now() ? JSON.parse(item.value) as T : null;
  }
}

export async function setCache(key: string, value: unknown, ttlSeconds = 60): Promise<void> {
  const serialized = JSON.stringify(value);
  memory.set(key, { value: serialized, expiresAt: Date.now() + ttlSeconds * 1000 });
  const redisClient = client();
  try {
    if (redisClient) await redisClient.set(key, serialized, 'EX', ttlSeconds);
  } catch {
    // In-process cache remains available when Redis is not configured or inaccessible.
  }
}

export async function deleteCache(key: string): Promise<void> {
  memory.delete(key);
  try { await client()?.del(key); } catch { /* no-op */ }
}
