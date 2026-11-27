const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREC_ID_REGEX = /^[0-9]{1,20}$/;

/**
 * 보안 응답 헤더 미들웨어 (OWASP 권장)
 */
function securityHeadersMiddleware(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: https:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'"
    ].join('; ')
  );
  next();
}

/**
 * 경량 Sliding-Window IP Rate Limiter (외부 의존성 없음, 메모리 누수 방지 정리 포함)
 */
function createRateLimiter({ windowMs = 60 * 1000, max = 60, message = '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.' } = {}) {
  const hits = new Map(); // ip -> number[]

  const cleanupTimer = setInterval(() => {
    const cutoff = Date.now() - windowMs;
    for (const [ip, timestamps] of hits.entries()) {
      const valid = timestamps.filter((t) => t > cutoff);
      if (valid.length === 0) {
        hits.delete(ip);
      } else {
        hits.set(ip, valid);
      }
    }
  }, Math.max(windowMs, 30000));
  if (typeof cleanupTimer.unref === 'function') {
    cleanupTimer.unref();
  }

  return function rateLimitMiddleware(req, res, next) {
    const ip = req.ip || req.socket?.remoteAddress || 'unknown';
    const now = Date.now();
    const cutoff = now - windowMs;
    const prev = hits.get(ip) || [];
    const recent = prev.filter((t) => t > cutoff);

    if (recent.length >= max) {
      const oldest = recent[0];
      const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
      res.setHeader('Retry-After', String(retryAfterSec));
      res.setHeader('X-RateLimit-Limit', String(max));
      res.setHeader('X-RateLimit-Remaining', '0');
      return res.status(429).json({
        success: false,
        error: message,
        retryAfterSeconds: retryAfterSec
      });
    }

    recent.push(now);
    hits.set(ip, recent);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - recent.length)));
    next();
  };
}

/**
 * 판례 일련번호(precSeq) 엄격 검증
 */
function isValidPrecId(id) {
  return typeof id === 'string' && PREC_ID_REGEX.test(id.trim());
}

/**
 * 클라이언트 격리 UUID v4 검증
 */
function parseClientId(raw) {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().toLowerCase();
  return UUID_V4_REGEX.test(trimmed) ? trimmed : null;
}

/**
 * 안전한 문자열 절단
 */
function sanitizeString(val, maxLen = 500) {
  if (val === null || val === undefined) return '';
  return String(val).trim().slice(0, maxLen);
}

/**
 * 북마크 항목 Allowlist 정규화 (임의 필드 주입 및 대용량 페이로드 차단)
 */
function sanitizeBookmarkItem(item) {
  if (!item || typeof item !== 'object') return null;
  const precSeq = sanitizeString(item.precSeq, 20);
  if (!isValidPrecId(precSeq)) return null;

  let externalUrl = sanitizeString(item.externalUrl, 300);
  if (externalUrl && !externalUrl.startsWith('https://www.law.go.kr/')) {
    externalUrl = '';
  }

  return {
    precSeq,
    caseName: sanitizeString(item.caseName || '판례', 300),
    caseNumber: sanitizeString(item.caseNumber, 120),
    judgDate: sanitizeString(item.judgDate, 30),
    courtName: sanitizeString(item.courtName, 80),
    caseType: sanitizeString(item.caseType, 50),
    judgType: sanitizeString(item.judgType, 50),
    dataSource: sanitizeString(item.dataSource, 80),
    holding: sanitizeString(item.holding, 1200),
    summary: sanitizeString(item.summary, 1500),
    refStatute: sanitizeString(item.refStatute, 600),
    externalUrl
  };
}

/**
 * 클라이언트별 격리된 비동기 원자적 북마크 저장소 (최대 클라이언트 수 & 항목 수 캡)
 */
class BookmarkStore {
  constructor(filePath, { maxItemsPerClient = 100, maxClients = 1000 } = {}) {
    this.filePath = filePath;
    this.maxItemsPerClient = maxItemsPerClient;
    this.maxClients = maxClients;
    this.data = {}; // clientId -> BookmarkItem[]
    this._writeQueue = Promise.resolve();
    this._loadSync();
  }

  _loadSync() {
    try {
      if (!fs.existsSync(this.filePath)) {
        this.data = {};
        return;
      }
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      // 레거시 배열 포맷 호환 처리 (단일 공용 배열은 분리하여 초기화)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.data = parsed;
      } else {
        this.data = {};
      }
    } catch (err) {
      console.warn(`[BookmarkStore Warning] Failed to read bookmarks: ${err.message}`);
      this.data = {};
    }
  }

  getList(clientId) {
    return Array.isArray(this.data[clientId]) ? this.data[clientId] : [];
  }

  async add(clientId, rawItem, savedAt) {
    const clean = sanitizeBookmarkItem(rawItem);
    if (!clean) return { ok: false, error: '올바른 판례 데이터가 아닙니다.' };

    const list = this.getList(clientId);
    const exists = list.some((b) => String(b.precSeq) === String(clean.precSeq));
    if (!exists) {
      const updated = [{ ...clean, savedAt }, ...list].slice(0, this.maxItemsPerClient);
      this._enforceClientCap(clientId);
      this.data[clientId] = updated;
      await this._persist();
    }
    return { ok: true, bookmarks: this.getList(clientId) };
  }

  async remove(clientId, precSeq) {
    const list = this.getList(clientId);
    const filtered = list.filter((b) => String(b.precSeq) !== String(precSeq));
    this.data[clientId] = filtered;
    await this._persist();
    return { ok: true, bookmarks: filtered };
  }

  _enforceClientCap(incomingClientId) {
    const keys = Object.keys(this.data);
    if (!this.data[incomingClientId] && keys.length >= this.maxClients) {
      delete this.data[keys[0]];
    }
  }

  _persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this._writeQueue = this._writeQueue.then(async () => {
      const dir = path.dirname(this.filePath);
      await fsp.mkdir(dir, { recursive: true });
      const tmpFile = `${this.filePath}.${process.pid}.tmp`;
      await fsp.writeFile(tmpFile, snapshot, 'utf8');
      await fsp.rename(tmpFile, this.filePath);
    }).catch((err) => {
      console.error(`[BookmarkStore Error] Atomic write failed: ${err.message}`);
    });
    return this._writeQueue;
  }
}

module.exports = {
  securityHeadersMiddleware,
  createRateLimiter,
  isValidPrecId,
  parseClientId,
  sanitizeString,
  sanitizeBookmarkItem,
  BookmarkStore
};
