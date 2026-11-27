const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

/**
 * 유계(Bounded) LRU + TTL 캐시 및 동시 요청 병합(In-flight Coalescing) + 디스크 영속화
 */
class LRUCache {
  constructor({ maxSize = 500, defaultTTLMs = 60 * 60 * 1000, persistFile = null, persistPrefixes = [] } = {}) {
    this.maxSize = maxSize;
    this.defaultTTLMs = defaultTTLMs;
    this.persistFile = persistFile;
    this.persistPrefixes = persistPrefixes;
    this.store = new Map(); // key -> { value, expiresAt }
    this.inFlight = new Map(); // key -> Promise
    this._persistTimer = null;
    this._writing = false;
    this._pendingWrite = false;
  }

  get(key) {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    // LRU 순서 갱신 (가장 최근 사용으로 이동)
    this.store.delete(key);
    this.store.set(key, entry);
    return entry.value;
  }

  set(key, value, ttlMs = this.defaultTTLMs) {
    if (this.store.has(key)) {
      this.store.delete(key);
    } else if (this.store.size >= this.maxSize) {
      // 가장 오래된 항목 제거
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
      }
    }
    this.store.set(key, {
      value,
      expiresAt: Date.now() + ttlMs
    });

    if (this.persistFile && this._shouldPersist(key)) {
      this.schedulePersist();
    }
  }

  delete(key) {
    return this.store.delete(key);
  }

  clear() {
    this.store.clear();
  }

  get size() {
    return this.store.size;
  }

  pruneExpired() {
    const now = Date.now();
    let removed = 0;
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /**
   * 동일 키에 대한 동시 캐시 미스(Stampede)를 단일 비동기 작업으로 병합
   */
  async getOrSet(key, factory, ttlMs = this.defaultTTLMs) {
    const cached = this.get(key);
    if (cached !== undefined) {
      return { value: cached, hit: true };
    }

    if (this.inFlight.has(key)) {
      const value = await this.inFlight.get(key);
      return { value, hit: true };
    }

    const promise = (async () => {
      try {
        const result = await factory();
        if (result !== undefined && result !== null) {
          this.set(key, result, ttlMs);
        }
        return result;
      } finally {
        this.inFlight.delete(key);
      }
    })();

    this.inFlight.set(key, promise);
    const value = await promise;
    return { value, hit: false };
  }

  _shouldPersist(key) {
    if (!this.persistPrefixes || this.persistPrefixes.length === 0) return true;
    return this.persistPrefixes.some((prefix) => key.startsWith(prefix));
  }

  loadFromDisk() {
    if (!this.persistFile) return 0;
    try {
      if (!fs.existsSync(this.persistFile)) return 0;
      const raw = fs.readFileSync(this.persistFile, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') return 0;

      const now = Date.now();
      let loaded = 0;
      for (const [key, entry] of Object.entries(parsed)) {
        if (loaded >= this.maxSize) break;
        if (entry && entry.expiresAt > now && entry.value !== undefined) {
          this.store.set(key, { value: entry.value, expiresAt: entry.expiresAt });
          loaded++;
        }
      }
      return loaded;
    } catch (err) {
      console.warn(`[Cache Warning] Failed to load disk cache: ${err.message}`);
      return 0;
    }
  }

  schedulePersist(delayMs = 2000) {
    if (!this.persistFile) return;
    if (this._persistTimer) clearTimeout(this._persistTimer);
    this._persistTimer = setTimeout(() => {
      this._persistTimer = null;
      this.flushToDisk().catch((err) => {
        console.warn(`[Cache Warning] Failed to persist disk cache: ${err.message}`);
      });
    }, delayMs);
    if (typeof this._persistTimer.unref === 'function') {
      this._persistTimer.unref();
    }
  }

  async flushToDisk() {
    if (!this.persistFile) return;
    if (this._writing) {
      this._pendingWrite = true;
      return;
    }
    this._writing = true;
    try {
      const now = Date.now();
      const snapshot = {};
      for (const [key, entry] of this.store.entries()) {
        if (entry.expiresAt > now && this._shouldPersist(key)) {
          snapshot[key] = entry;
        }
      }
      const dir = path.dirname(this.persistFile);
      await fsp.mkdir(dir, { recursive: true });
      const tmpFile = `${this.persistFile}.${process.pid}.tmp`;
      await fsp.writeFile(tmpFile, JSON.stringify(snapshot), 'utf8');
      await fsp.rename(tmpFile, this.persistFile);
    } finally {
      this._writing = false;
      if (this._pendingWrite) {
        this._pendingWrite = false;
        await this.flushToDisk();
      }
    }
  }
}

module.exports = { LRUCache };
