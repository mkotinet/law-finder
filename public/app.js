/**
 * LawFinder v2.1 - Client Application Logic
 * Strict CSP Compliant (Zero inline event handlers), 3-Level Easy Legal Explainer,
 * AbortController Race Guard, Pagination, Live Version Rollover, PWA Install,
 * Per-Device Bookmark Isolation
 */

// ---------------------------------------------------------------------------
// 0. 최상단 PWA beforeinstallprompt 선제 캡처 (지침 제15원칙)
// ---------------------------------------------------------------------------
let deferredInstallPrompt = null;

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  showPwaInstallControls();
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  const banner = document.getElementById('pwa-install-banner');
  const modalBox = document.getElementById('pwa-native-install-box');
  if (banner) banner.hidden = true;
  if (modalBox) modalBox.hidden = true;
  showToast('LawFinder 앱이 홈 화면에 설치되었습니다!');
});

// ---------------------------------------------------------------------------
// 전역 상태 & 눈높이 설정
// ---------------------------------------------------------------------------
const CLIENT_VERSION =
  document.querySelector('meta[name="app-version"]')?.getAttribute('content') || '2.1.0';
const PAGE_SIZE = 15;

const READING_LEVEL_INFO = {
  middle: {
    id: 'middle',
    label: '중학생',
    badge: '🌱 중학생',
    hint: '어려운 한자어 없이 학교·친구·용돈 등 쉬운 일상 비유로 설명합니다'
  },
  high: {
    id: 'high',
    label: '고등학생',
    badge: '📘 고등학생',
    hint: '통합사회·정치와 법 수준으로 개념 뜻풀이와 알바·거래 예시를 제공합니다'
  },
  general: {
    id: 'general',
    label: '대학생·일반',
    badge: '🎓 대학생·일반',
    hint: '실생활 계약·분쟁 예시와 체크포인트로 쉽게 설명합니다'
  }
};

let currentTab = 'search';
let currentSearchQuery = '';
let currentSearchScope = '1';
let currentCourtFilter = '';
let currentPage = 1;
let currentTotalCount = 0;
let currentReadingLevel = loadSavedReadingLevel();
let currentModalPrecSeq = null;
let currentModalPrecedent = null;
let currentModalExplanation = null;
let bookmarksList = [];
let searchAbortController = null;
let detailAbortController = null;
let explainAbortController = null;
let versionCheckRunning = false;

// 판례별 3단계 눈높이 해설 클라이언트 인메모리 캐시 (레벨 전환 시 0ms 즉시 렌더링)
const explainClientCache = new Map();

// ---------------------------------------------------------------------------
// 초기화
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  bindStaticEventListeners();
  applyReadingLevelUI(currentReadingLevel);
  restoreTopbarState();
  initApp();
  registerServiceWorker();
  setupMobileLifecycle();
  setupKeyboardShortcuts();
});

async function initApp() {
  await checkServerHealth();
  await loadBookmarks();
  executeSearch(1);

  setTimeout(() => checkAppVersionUpdate(), 1200);
  setTimeout(() => checkWhatsNewPopup(), 600);
}

// ---------------------------------------------------------------------------
// 눈높이 레벨 전역 관리 (중학생 / 고등학생 / 대학생·일반)
// ---------------------------------------------------------------------------
function loadSavedReadingLevel() {
  const saved = localStorage.getItem('lawfinder_level');
  return READING_LEVEL_INFO[saved] ? saved : 'general';
}

function setReadingLevel(level, { notify = true } = {}) {
  if (!READING_LEVEL_INFO[level]) return;
  const changed = currentReadingLevel !== level;
  currentReadingLevel = level;
  localStorage.setItem('lawfinder_level', level);
  applyReadingLevelUI(level);

  // 상세 모달의 쉬운 해설 데이터가 이미 로드되어 있으면 네트워크 호출 없이 0ms 즉시 전환
  if (currentModalExplanation) {
    renderEasyExplanation(currentModalExplanation);
  }

  if (notify && changed) {
    showToast(`${READING_LEVEL_INFO[level].badge} 눈높이로 전환되었습니다.`);
  }
}

function applyReadingLevelUI(level) {
  const info = READING_LEVEL_INFO[level] || READING_LEVEL_INFO.general;
  document.querySelectorAll('[data-reading-level]').forEach((btn) => {
    const isActive = btn.dataset.readingLevel === info.id;
    btn.classList.toggle('active', isActive);
    btn.setAttribute('aria-pressed', String(isActive));
  });
  setText('level-bar-hint', info.hint);
  setText('ai-active-level-badge', info.badge);
}

// ---------------------------------------------------------------------------
// 클라이언트 기기별 익명 UUID v4 식별자 (북마크 격리용)
// ---------------------------------------------------------------------------
function getOrCreateClientId() {
  const storageKey = 'lawfinder_client_id';
  let id = localStorage.getItem(storageKey);
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (id && uuidRegex.test(id)) return id;

  if (window.crypto && typeof window.crypto.randomUUID === 'function') {
    id = window.crypto.randomUUID();
  } else {
    id = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
  localStorage.setItem(storageKey, id);
  return id;
}

function getClientHeaders(extra = {}) {
  return {
    'X-Client-Id': getOrCreateClientId(),
    ...extra
  };
}

// ---------------------------------------------------------------------------
// 정적 DOM 이벤트 바인딩 (엄격 CSP 준수 - 인라인 핸들러 0개)
// ---------------------------------------------------------------------------
function bindStaticEventListeners() {
  document.getElementById('btn-brand-home')?.addEventListener('click', () => switchTab('search'));

  document.querySelectorAll('.nav-tab[data-tab]').forEach((btn) => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // 전역 및 모달 눈높이 선택 버튼
  document.querySelectorAll('[data-reading-level]').forEach((btn) => {
    btn.addEventListener('click', () => setReadingLevel(btn.dataset.readingLevel, { notify: true }));
  });

  // PWA 설치 배너 & 헤더 아이콘
  document.getElementById('btn-pwa-banner-install')?.addEventListener('click', triggerPwaInstall);
  document.getElementById('btn-pwa-banner-close')?.addEventListener('click', () => {
    const banner = document.getElementById('pwa-install-banner');
    if (banner) banner.hidden = true;
    sessionStorage.setItem('lawfinder_pwa_banner_dismissed', '1');
  });
  document.getElementById('btn-header-install')?.addEventListener('click', () => openModalById('modalPwaGuide'));
  document.getElementById('btn-pwa-modal-install')?.addEventListener('click', triggerPwaInstall);

  // 상단바 접기/펼치기 (지침 제19원칙)
  document.getElementById('btnToggleTopbar')?.addEventListener('click', toggleTopbarCollapsed);
  document.getElementById('btnQuickExpand')?.addEventListener('click', () => setTopbarCollapsed(false));

  // 모바일 상세 필터 아코디언
  document.getElementById('btnToggleFilters')?.addEventListener('click', () => {
    const filtersEl = document.getElementById('topbarCollapsibleFilters');
    const isOpen = filtersEl?.classList.contains('open');
    updateFiltersState(!isOpen);
  });

  // 검색 입력 & 실행
  const searchInput = document.getElementById('search-query-input');
  searchInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') executeSearch(1);
  });
  document.getElementById('search-submit-btn')?.addEventListener('click', () => executeSearch(1));

  // 검색 범위 라디오
  document.querySelectorAll('input[name="searchScope"]').forEach((radio) => {
    radio.addEventListener('change', () => executeSearch(1));
  });

  // 법원 필터 칩
  document.querySelectorAll('.court-chip[data-court]').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.court-chip').forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
      currentCourtFilter = chip.dataset.court || '';
      executeSearch(1);
    });
  });

  // 추천 키워드 태그
  document.querySelectorAll('.quick-tag[data-keyword]').forEach((btn) => {
    btn.addEventListener('click', () => quickSearch(btn.dataset.keyword));
  });

  // 판례 카드 목록 이벤트 위임 (검색 / AI 결과 / 보관함 공용)
  ['precedents-list-container', 'bookmarks-list-container', 'ai-result-container'].forEach((containerId) => {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.addEventListener('click', (event) => {
      // AI 추천 키워드 태그 클릭 -> 판례 검색 탭으로 이동
      const kwBtn = event.target.closest('.keyword-tag[data-keyword]');
      if (kwBtn) {
        switchTab('search');
        quickSearch(kwBtn.dataset.keyword);
        return;
      }

      // 카드 내 [✨ 쉬운 해설] 원클릭 버튼 -> 상세 모달의 쉬운 해설 탭으로 직행
      const easyBtn = event.target.closest('.card-easy-btn[data-explain-seq]');
      if (easyBtn) {
        event.stopPropagation();
        openDetailModal(easyBtn.dataset.explainSeq, { initialTab: 'easy' });
        return;
      }

      // 카드 내 북마크 토글 버튼
      const bookmarkBtn = event.target.closest('.card-bookmark-btn[data-prec-seq]');
      if (bookmarkBtn) {
        event.stopPropagation();
        handleCardBookmarkClick(bookmarkBtn, bookmarkBtn.dataset.precSeq);
        return;
      }

      // 카드 본문 클릭 -> 상세 모달 열기
      const card = event.target.closest('.precedent-card[data-prec-seq]');
      if (card) {
        openDetailModal(card.dataset.precSeq, { initialTab: 'holding' });
      }
    });
  });

  // 페이지네이션 이벤트 위임
  document.getElementById('pagination-wrap')?.addEventListener('click', (event) => {
    const btn = event.target.closest('.page-btn[data-page]');
    if (!btn || btn.disabled) return;
    const targetPage = Number.parseInt(btn.dataset.page, 10);
    if (targetPage && targetPage !== currentPage) {
      executeSearch(targetPage);
      document.getElementById('search-results-meta')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  });

  // AI 법률 Q&A 입력 및 예시 질문
  const aiInput = document.getElementById('ai-question-input');
  const charCount = document.getElementById('ai-char-count');
  aiInput?.addEventListener('input', () => {
    if (charCount) charCount.textContent = String(aiInput.value.length);
  });
  aiInput?.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') executeAiAsk();
  });
  document.querySelectorAll('.suggest-chip[data-ai-question]').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (aiInput) {
        aiInput.value = btn.dataset.aiQuestion || '';
        if (charCount) charCount.textContent = String(aiInput.value.length);
        aiInput.focus();
      }
    });
  });
  document.getElementById('ai-submit-btn')?.addEventListener('click', executeAiAsk);

  // 상세 모달 이벤트
  const detailModal = document.getElementById('detail-modal');
  detailModal?.addEventListener('click', (e) => {
    if (e.target === detailModal) closeDetailModalDirect();
  });
  document.getElementById('btn-close-detail-modal')?.addEventListener('click', closeDetailModalDirect);
  document.getElementById('btn-close-detail-footer')?.addEventListener('click', closeDetailModalDirect);
  document.getElementById('btn-copy-modal')?.addEventListener('click', copyModalContent);
  document.getElementById('modal-bookmark-toggle-btn')?.addEventListener('click', toggleModalBookmark);

  document.querySelectorAll('.modal-tab[data-detail-tab]').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => switchDetailTab(tabBtn.dataset.detailTab));
  });

  // 공통 모달 닫기 (PWA 가이드)
  document.querySelectorAll('[data-close-modal]').forEach((btn) => {
    btn.addEventListener('click', () => closeModalById(btn.dataset.closeModal));
  });
  document.getElementById('modalPwaGuide')?.addEventListener('click', (e) => {
    if (e.target.id === 'modalPwaGuide') closeModalById('modalPwaGuide');
  });

  // What's New 모달 닫기
  const dismissWhatsNew = () => {
    localStorage.setItem('dismissed_update_version', CLIENT_VERSION);
    closeModalById('modalWhatsNew');
  };
  document.getElementById('btn-dismiss-whatsnew')?.addEventListener('click', dismissWhatsNew);
  document.getElementById('btn-dismiss-whatsnew-x')?.addEventListener('click', dismissWhatsNew);
  document.getElementById('modalWhatsNew')?.addEventListener('click', (e) => {
    if (e.target.id === 'modalWhatsNew') dismissWhatsNew();
  });
}

// ---------------------------------------------------------------------------
// 1. 서버 상태 점검
// ---------------------------------------------------------------------------
async function checkServerHealth() {
  const statusEl = document.getElementById('server-status');
  if (!statusEl) return;
  try {
    const res = await fetch('/api/health', { cache: 'no-store' });
    const data = await res.json();
    if (data.status === 'ok') {
      const modeText = data.law_oc_configured ? '법제처 LIVE' : '데모 모드';
      const aiText = data.gemini_configured ? `Gemini (${data.gemini_model || 'Flash'})` : '규칙 NLP';
      statusEl.innerHTML = `<span class="status-dot"></span><span class="status-text">${escapeHtml(modeText)} · ${escapeHtml(aiText)}</span>`;
      statusEl.title = `서버 정상 가동 중 (v${data.version} | KST: ${data.timeKST})`;
    }
  } catch {
    statusEl.innerHTML = `<span class="status-dot error"></span><span class="status-text">서버 연결 오류</span>`;
  }
}

// ---------------------------------------------------------------------------
// 2. 탭 전환 & 상단바 접기/펼치기 (지침 제19원칙)
// ---------------------------------------------------------------------------
function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.nav-tab').forEach((btn) => btn.classList.remove('active'));
  document.querySelectorAll('.tab-view').forEach((view) => view.classList.remove('active'));

  document.getElementById(`tab-btn-${tabName}`)?.classList.add('active');
  document.getElementById(`view-${tabName}`)?.classList.add('active');

  if (tabName === 'bookmarks') {
    renderBookmarksView();
  }
  updateCollapsedSummaryBadge();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function restoreTopbarState() {
  const saved = localStorage.getItem('app_topbar_collapsed') === 'true';
  setTopbarCollapsed(saved, false);
}

function toggleTopbarCollapsed() {
  const isCollapsed = document.body.classList.contains('topbar-collapsed');
  setTopbarCollapsed(!isCollapsed, true);
}

function setTopbarCollapsed(collapsed, persist = true) {
  document.body.classList.toggle('topbar-collapsed', collapsed);
  const summaryBar = document.getElementById('collapsedSummary');
  const toggleBtn = document.getElementById('btnToggleTopbar');
  if (summaryBar) summaryBar.hidden = !collapsed;
  if (toggleBtn) toggleBtn.textContent = collapsed ? '▼' : '▲';
  if (persist) localStorage.setItem('app_topbar_collapsed', String(collapsed));
  updateCollapsedSummaryBadge();
}

function updateCollapsedSummaryBadge() {
  const badge = document.getElementById('collapsedQueryBadge');
  if (!badge) return;
  const levelBadge = READING_LEVEL_INFO[currentReadingLevel]?.badge || '🎓 대학생·일반';
  if (currentTab === 'ai') {
    badge.textContent = `🤖 AI 법률 Q&A (${levelBadge})`;
  } else if (currentTab === 'bookmarks') {
    badge.textContent = `⭐ 보관함 (${bookmarksList.length}건)`;
  } else if (currentSearchQuery) {
    const courtLabel = currentCourtFilter ? ` · ${currentCourtFilter}` : '';
    badge.textContent = `🔍 "${currentSearchQuery}"${courtLabel} (${currentTotalCount}건)`;
  } else {
    badge.textContent = `🔍 대표 민생 판례 (${levelBadge})`;
  }
}

function updateFiltersState(open) {
  const filtersEl = document.getElementById('topbarCollapsibleFilters');
  const toggleBtn = document.getElementById('btnToggleFilters');
  const icon = document.getElementById('filterToggleIcon');
  if (!filtersEl) return;
  filtersEl.classList.toggle('open', open);
  if (toggleBtn) toggleBtn.setAttribute('aria-expanded', String(open));
  if (icon) icon.textContent = open ? '▲' : '▼';
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeDetailModalDirect();
      closeModalById('modalPwaGuide');
      closeModalById('modalWhatsNew');
      return;
    }

    if (e.altKey && (e.key === 'h' || e.key === 'H')) {
      e.preventDefault();
      toggleTopbarCollapsed();
      return;
    }

    const activeTag = document.activeElement?.tagName;
    if (e.key === '/' && activeTag !== 'INPUT' && activeTag !== 'TEXTAREA') {
      e.preventDefault();
      switchTab('search');
      setTopbarCollapsed(false);
      document.getElementById('search-query-input')?.focus();
    }
  });
}

// ---------------------------------------------------------------------------
// 3. 판례 검색 (AbortController 경쟁 조건 방지 + 페이지네이션 + 모바일 자동 접힘)
// ---------------------------------------------------------------------------
async function executeSearch(page = 1) {
  const queryInput = document.getElementById('search-query-input');
  const query = queryInput ? queryInput.value.trim() : '';
  const searchScope = document.querySelector('input[name="searchScope"]:checked')?.value || '1';

  currentSearchQuery = query;
  currentSearchScope = searchScope;
  currentPage = page;

  if (window.innerWidth <= 768 && query) {
    updateFiltersState(false);
    queryInput?.blur();
  }

  if (searchAbortController) {
    searchAbortController.abort();
  }
  searchAbortController = new AbortController();

  const loadingEl = document.getElementById('search-loading');
  const containerEl = document.getElementById('precedents-list-container');
  const metaBar = document.getElementById('search-results-meta');
  const warningEl = document.getElementById('search-warning-banner');
  const totalCountEl = document.getElementById('total-count-num');
  const pageIndEl = document.getElementById('page-indicator-text');
  const badgeEl = document.getElementById('data-source-badge');
  const paginationEl = document.getElementById('pagination-wrap');

  if (loadingEl) loadingEl.hidden = false;
  if (containerEl) containerEl.innerHTML = '';
  if (metaBar) metaBar.hidden = true;
  if (warningEl) warningEl.hidden = true;
  if (paginationEl) paginationEl.hidden = true;

  try {
    const params = new URLSearchParams({
      query,
      search: searchScope,
      court: currentCourtFilter,
      page: String(page),
      display: String(PAGE_SIZE)
    });
    const res = await fetch(`/api/prec/search?${params.toString()}`, {
      signal: searchAbortController.signal
    });
    const data = await res.json();

    if (loadingEl) loadingEl.hidden = true;

    if (!res.ok) {
      if (containerEl) {
        containerEl.innerHTML = `<div class="error-state">${escapeHtml(data.error || '검색 요청 처리에 실패했습니다.')}</div>`;
      }
      return;
    }

    if (data.warning && warningEl) {
      warningEl.textContent = `⚠️ ${data.warning}`;
      warningEl.hidden = false;
    }

    if (data.success && Array.isArray(data.items)) {
      currentTotalCount = data.totalCount || data.items.length;
      if (metaBar) metaBar.hidden = false;
      if (totalCountEl) totalCountEl.textContent = currentTotalCount.toLocaleString('ko-KR');

      const totalPages = Math.max(1, Math.ceil(currentTotalCount / PAGE_SIZE));
      if (pageIndEl) {
        pageIndEl.textContent = totalPages > 1 ? `(${page} / ${totalPages} 페이지)` : '';
      }

      if (badgeEl) {
        if (data.isFeatured) {
          badgeEl.textContent = '대표 민생 판례 큐레이션 (검색 시 실시간 연동)';
          badgeEl.classList.add('featured');
        } else if (data.isMock) {
          badgeEl.textContent = '오프라인 대표 판례 데모 모드';
          badgeEl.classList.add('featured');
        } else {
          badgeEl.textContent = '법제처 국가법령정보 실시간 HTTPS 연동';
          badgeEl.classList.remove('featured');
        }
      }

      renderPrecedentCards(data.items, containerEl);
      renderPagination(currentTotalCount, page, PAGE_SIZE);
      updateCollapsedSummaryBadge();
    } else if (containerEl) {
      containerEl.innerHTML = `<div class="empty-state">검색 결과가 없습니다. 다른 검색어를 시도해 보세요.</div>`;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (loadingEl) loadingEl.hidden = true;
    if (containerEl) {
      containerEl.innerHTML = `<div class="error-state">판례 검색 중 오류가 발생했습니다: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function quickSearch(keyword) {
  const input = document.getElementById('search-query-input');
  if (input) {
    input.value = keyword;
    executeSearch(1);
  }
}

function renderPagination(totalCount, page, pageSize) {
  const wrap = document.getElementById('pagination-wrap');
  if (!wrap) return;

  const totalPages = Math.min(100, Math.ceil(totalCount / pageSize));
  if (totalPages <= 1) {
    wrap.hidden = true;
    wrap.innerHTML = '';
    return;
  }

  const maxButtons = 5;
  let start = Math.max(1, page - Math.floor(maxButtons / 2));
  let end = Math.min(totalPages, start + maxButtons - 1);
  if (end - start + 1 < maxButtons) {
    start = Math.max(1, end - maxButtons + 1);
  }

  let html = `<button type="button" class="page-btn" data-page="${page - 1}" ${page <= 1 ? 'disabled' : ''}>◀ 이전</button>`;

  if (start > 1) {
    html += `<button type="button" class="page-btn" data-page="1">1</button>`;
    if (start > 2) html += `<span class="page-indicator-text">…</span>`;
  }

  for (let p = start; p <= end; p++) {
    html += `<button type="button" class="page-btn ${p === page ? 'active' : ''}" data-page="${p}" ${p === page ? 'aria-current="page"' : ''}>${p}</button>`;
  }

  if (end < totalPages) {
    if (end < totalPages - 1) html += `<span class="page-indicator-text">…</span>`;
    html += `<button type="button" class="page-btn" data-page="${totalPages}">${totalPages}</button>`;
  }

  html += `<button type="button" class="page-btn" data-page="${page + 1}" ${page >= totalPages ? 'disabled' : ''}>다음 ▶</button>`;

  wrap.innerHTML = html;
  wrap.hidden = false;
}

// ---------------------------------------------------------------------------
// 4. 판례 카드 목록 렌더링 (Zero inline onclick — [✨ 쉬운 해설] 원클릭 버튼 탑재)
// ---------------------------------------------------------------------------
function renderPrecedentCards(items, targetContainer) {
  if (!targetContainer) return;
  if (!items || items.length === 0) {
    targetContainer.innerHTML = `<div class="empty-state"><span class="empty-icon">🔍</span>표시할 판례가 없습니다. 검색어나 법원 필터를 변경해 보세요.</div>`;
    return;
  }

  targetContainer.innerHTML = items
    .map((item) => {
      const seq = escapeHtml(item.precSeq || '');
      const isBookmarked = isItemBookmarked(item.precSeq);
      const previewText = item.holding || item.summary || '';
      const sourceBadge =
        item.dataSource && item.dataSource !== item.courtName
          ? `<span class="badge-tag badge-source">${escapeHtml(item.dataSource)}</span>`
          : '';

      const previewBlock = previewText
        ? `<p class="card-summary-preview">${escapeHtml(previewText)}</p>`
        : `<div class="card-meta-preview">📌 ${escapeHtml(item.courtName || '법원')} · ${escapeHtml(item.caseType || '판례')} · 선고 ${escapeHtml(item.judgDate || '-')}</div>`;

      return `
        <article class="precedent-card" data-prec-seq="${seq}">
          <div>
            <div class="card-header-row">
              <div class="card-badges">
                <span class="badge-tag badge-court">${escapeHtml(item.courtName || '법원')}</span>
                ${item.caseType ? `<span class="badge-tag badge-type">${escapeHtml(item.caseType)}</span>` : ''}
                ${item.judgDate ? `<span class="badge-tag badge-date">${escapeHtml(item.judgDate)}</span>` : ''}
                ${sourceBadge}
              </div>
              <button
                type="button"
                class="card-bookmark-btn ${isBookmarked ? 'active' : ''}"
                data-prec-seq="${seq}"
                aria-label="보관함 저장 토글"
                title="보관함 저장"
              >${isBookmarked ? '★' : '☆'}</button>
            </div>

            <h3 class="card-title">${escapeHtml(item.caseName || '판례')}</h3>
            <div class="card-case-number">${escapeHtml(item.caseNumber || '')} ${item.judgType ? `[${escapeHtml(item.judgType)}]` : ''}</div>
            ${previewBlock}
          </div>

          <div class="card-footer-row">
            <button type="button" class="card-easy-btn" data-explain-seq="${seq}" title="중학생·고등학생·대학생 눈높이로 쉽게 읽기">✨ 쉬운 해설</button>
            <span class="card-view-detail-btn">원문 보기 ➔</span>
          </div>
        </article>
      `;
    })
    .join('');
}

// ---------------------------------------------------------------------------
// 5. 판례 상세 모달 & 3단계 눈높이 쉬운 해설 (0ms 레벨 전환 + 캐시)
// ---------------------------------------------------------------------------
async function openDetailModal(precSeq, { initialTab = 'holding' } = {}) {
  if (!precSeq) return;
  const modal = document.getElementById('detail-modal');
  modal?.classList.add('active');
  document.body.style.overflow = 'hidden';

  currentModalPrecSeq = String(precSeq);
  currentModalPrecedent = null;
  currentModalExplanation = null;

  if (detailAbortController) detailAbortController.abort();
  if (explainAbortController) explainAbortController.abort();
  detailAbortController = new AbortController();

  const noticeEl = document.getElementById('modal-external-notice');
  const extLink = document.getElementById('modal-external-link');
  const easyContentEl = document.getElementById('modal-easy-content');
  const easyLoadingEl = document.getElementById('modal-easy-loading');
  if (noticeEl) noticeEl.hidden = true;
  if (easyContentEl) easyContentEl.innerHTML = '';
  if (easyLoadingEl) easyLoadingEl.hidden = true;
  if (extLink) extLink.href = `https://www.law.go.kr/LSW/precInfoP.do?precSeq=${encodeURIComponent(precSeq)}&mode=0`;

  setText('modal-case-name', '판례 불러오는 중...');
  setText('modal-case-number', '');
  setText('modal-court-name', '-');
  setText('modal-case-type', '-');
  setText('modal-judg-date', '-');
  setText('modal-holding-text', '법제처 서버에서 상세 데이터를 조회하고 있습니다...');
  setText('modal-summary-text', '조회 중...');
  setText('modal-statute-text', '조회 중...');
  setText('modal-precedent-text', '조회 중...');
  setText('modal-full-content', '조회 중...');

  switchDetailTab(initialTab);

  try {
    const res = await fetch(`/api/prec/detail?id=${encodeURIComponent(precSeq)}`, {
      signal: detailAbortController.signal
    });
    const result = await res.json();

    if (res.ok && result.success && result.data) {
      const data = result.data;
      currentModalPrecedent = data;

      setText('modal-case-name', data.caseName || '판례');
      setText('modal-case-number', `${data.caseNumber || ''} ${data.judgType ? `[${data.judgType}]` : ''}`.trim());
      setText('modal-court-name', data.courtName || '-');
      setText('modal-case-type', data.caseType || '판례');
      setText('modal-judg-date', data.judgDate || '-');

      setText('modal-holding-text', data.holding || '등록된 판시사항이 없습니다.');
      setText('modal-summary-text', data.summary || '등록된 판결요지가 없습니다.');
      setText('modal-statute-text', data.refStatute || '등록된 참조조문 정보가 없습니다.');
      setText('modal-precedent-text', data.refPrecedent || '등록된 참조판례 정보가 없습니다.');
      setText('modal-full-content', data.content || data.summary || '전문 텍스트가 제공되지 않는 판례입니다. 하단 [법제처 원문] 버튼을 이용해 주세요.');

      if (noticeEl) noticeEl.hidden = !result.isExternalOnly;
      if (extLink && data.externalUrl) {
        extLink.href = data.externalUrl;
      }

      updateModalBookmarkButton();
    } else {
      setText('modal-holding-text', result.error || '판례 정보를 불러오지 못했습니다.');
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    setText('modal-holding-text', `오류 발생: ${err.message}`);
  }
}

async function loadPrecedentEasyExplanation(precSeq) {
  if (!precSeq) return;
  const seqKey = String(precSeq);
  const loadingEl = document.getElementById('modal-easy-loading');
  const contentEl = document.getElementById('modal-easy-content');

  // 1) 클라이언트 인메모리 캐시 확인 (0ms 즉시 표시)
  if (explainClientCache.has(seqKey)) {
    const cached = explainClientCache.get(seqKey);
    currentModalExplanation = cached;
    if (loadingEl) loadingEl.hidden = true;
    renderEasyExplanation(cached);
    return;
  }

  if (explainAbortController) explainAbortController.abort();
  explainAbortController = new AbortController();

  if (loadingEl) loadingEl.hidden = false;
  if (contentEl) contentEl.innerHTML = '';

  try {
    const res = await fetch(`/api/prec/explain?id=${encodeURIComponent(seqKey)}`, {
      signal: explainAbortController.signal
    });
    const result = await res.json();

    if (loadingEl) loadingEl.hidden = true;

    if (res.status === 429) {
      if (contentEl) {
        contentEl.innerHTML = `<div class="error-state">${escapeHtml(result.error || '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.')}</div>`;
      }
      return;
    }

    if (res.ok && result.success && result.data) {
      explainClientCache.set(seqKey, result);
      if (currentModalPrecSeq === seqKey) {
        currentModalExplanation = result;
        renderEasyExplanation(result);
      }
    } else if (contentEl) {
      contentEl.innerHTML = `<div class="error-state">${escapeHtml(result.error || '쉬운 해설을 불러오지 못했습니다.')}</div>`;
    }
  } catch (err) {
    if (err.name === 'AbortError') return;
    if (loadingEl) loadingEl.hidden = true;
    if (contentEl) {
      contentEl.innerHTML = `<div class="error-state">쉬운 해설 생성 중 오류가 발생했습니다: ${escapeHtml(err.message)}</div>`;
    }
  }
}

function renderEasyExplanation(result) {
  const contentEl = document.getElementById('modal-easy-content');
  if (!contentEl || !result || !result.data) return;

  const data = result.data;
  const level = currentReadingLevel;
  const levelInfo = READING_LEVEL_INFO[level] || READING_LEVEL_INFO.general;
  const levelBlock = data.levels?.[level] || data.levels?.general || {};
  const isGemini = result.analysisSource === 'gemini';
  const engineBadge = isGemini
    ? `🤖 Gemini 해설 (${escapeHtml(result.analysisModel || 'Flash')})${result.fromCache ? ' · ⚡ 캐시' : ''}`
    : '⚙️ 법률 용어사전 폴백';

  const glossaryHtml = (data.glossary || [])
    .map(
      (g) => `
        <div class="glossary-card">
          <span class="glossary-term">${escapeHtml(g.term)}</span>
          <span class="glossary-meaning">${escapeHtml(g.meaning)}</span>
        </div>
      `
    )
    .join('');

  contentEl.innerHTML = `
    <div class="easy-verdict-card">
      <div class="easy-verdict-top">
        <span class="easy-section-label">🎯 한 줄 결론</span>
        <span class="ai-source-pill ${isGemini ? 'gemini' : 'fallback'}">${engineBadge}</span>
      </div>
      <div class="easy-verdict-text">${escapeHtml(data.oneLineVerdict || '')}</div>
    </div>

    <div class="easy-story-card">
      <h4>${escapeHtml(levelBlock.title || `${levelInfo.badge} 쉬운 풀이`)}</h4>
      <p>${escapeHtml(levelBlock.explanation || '')}</p>
    </div>

    <div class="easy-example-card level-${escapeHtml(level)}">
      <h4>💡 ${escapeHtml(levelInfo.label)} 눈높이 실생활 예시</h4>
      <p>${escapeHtml(levelBlock.example || '')}</p>
    </div>

    ${
      glossaryHtml
        ? `<div class="glossary-section"><h4>🔑 판례 속 어려운 법률 용어 풀이</h4><div class="glossary-grid">${glossaryHtml}</div></div>`
        : ''
    }

    <div class="easy-disclaimer-note">
      ⚠️ ${escapeHtml(result.notice || '이해를 돕기 위한 AI 눈높이 비유이며, 정확한 법적 효력은 [판결요지] 및 [법제처 원문]을 확인하세요.')}
    </div>
  `;
}

function switchDetailTab(tabName) {
  document.querySelectorAll('.modal-tab').forEach((b) => {
    b.classList.toggle('active', b.dataset.detailTab === tabName);
  });
  document.querySelectorAll('.detail-tab-pane').forEach((p) => p.classList.remove('active'));
  document.getElementById(`modal-tab-${tabName}`)?.classList.add('active');
  const body = document.getElementById('detail-modal-body');
  if (body) body.scrollTop = 0;

  if (tabName === 'easy' && currentModalPrecSeq) {
    loadPrecedentEasyExplanation(currentModalPrecSeq);
  }
}

function closeDetailModalDirect() {
  if (detailAbortController) detailAbortController.abort();
  if (explainAbortController) explainAbortController.abort();
  document.getElementById('detail-modal')?.classList.remove('active');
  document.body.style.overflow = '';
}

function openModalById(id) {
  document.getElementById(id)?.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeModalById(id) {
  document.getElementById(id)?.classList.remove('active');
  if (!document.querySelector('.modal-overlay.active')) {
    document.body.style.overflow = '';
  }
}

function copyModalContent() {
  if (!currentModalPrecedent) return;
  const p = currentModalPrecedent;
  let extraEasy = '';
  if (currentModalExplanation?.data?.levels?.[currentReadingLevel]) {
    const lv = currentModalExplanation.data.levels[currentReadingLevel];
    const info = READING_LEVEL_INFO[currentReadingLevel];
    extraEasy = `\n\n【${info.label} 눈높이 쉬운 해설】\n한 줄 결론: ${currentModalExplanation.data.oneLineVerdict}\n풀이: ${lv.explanation}\n예시: ${lv.example}`;
  }
  const text = `[판례정보]\n사건명: ${p.caseName}\n사건번호: ${p.caseNumber}\n법원/선고일: ${p.courtName} (${p.judgDate})\n원문: ${p.externalUrl || ''}${extraEasy}\n\n【판시사항】\n${p.holding || '-'}\n\n【판결요지】\n${p.summary || '-'}\n\n【참조조문】\n${p.refStatute || '-'}`;
  navigator.clipboard
    .writeText(text)
    .then(() => showToast('판례 내용이 클립보드에 복사되었습니다.'))
    .catch(() => showToast('복사에 실패했습니다.'));
}

// ---------------------------------------------------------------------------
// 6. AI 법률 질문 & 2단계 RAG 질의응답 (눈높이 레벨 연동)
// ---------------------------------------------------------------------------
async function executeAiAsk() {
  const textarea = document.getElementById('ai-question-input');
  const question = textarea ? textarea.value.trim() : '';

  if (question.length < 2) {
    showToast('질문 내용을 2자 이상 입력해 주세요.');
    return;
  }

  const loadingEl = document.getElementById('ai-loading');
  const resultWrap = document.getElementById('ai-result-container');
  const submitBtn = document.getElementById('ai-submit-btn');

  if (loadingEl) loadingEl.hidden = false;
  if (resultWrap) {
    resultWrap.hidden = true;
    resultWrap.innerHTML = '';
  }
  if (submitBtn) submitBtn.disabled = true;

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, level: currentReadingLevel })
    });
    const data = await res.json();

    if (loadingEl) loadingEl.hidden = true;
    if (submitBtn) submitBtn.disabled = false;

    if (res.status === 429) {
      showToast(data.error || '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.');
      return;
    }

    if (res.ok && data.success && data.aiAnalysis) {
      if (resultWrap) {
        resultWrap.hidden = false;
        renderAiAnalysisResult(data, resultWrap);
        resultWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    } else {
      showToast(data.error || 'AI 분석에 실패했습니다. 다시 시도해 주세요.');
    }
  } catch (err) {
    if (loadingEl) loadingEl.hidden = true;
    if (submitBtn) submitBtn.disabled = false;
    showToast(`분석 중 오류 발생: ${err.message}`);
  }
}

function renderAiAnalysisResult(data, container) {
  const ai = data.aiAnalysis;
  const level = data.level || currentReadingLevel;
  const levelInfo = READING_LEVEL_INFO[level] || READING_LEVEL_INFO.general;
  const isGemini = data.analysisSource === 'gemini';
  const sourceLabel = isGemini
    ? `🤖 Gemini 실시간 분석 (${escapeHtml(data.analysisModel || 'Flash')})`
    : '⚙️ 규칙 기반 폴백 분석';

  const statutesHtml = (ai.relatedStatutes || [])
    .map((s) => `<span class="statute-tag">📜 ${escapeHtml(s)}</span>`)
    .join('');

  const allKeywords = [ai.searchKeyword, ...(ai.subKeywords || [])].filter(Boolean);
  const uniqueKeywords = [...new Set(allKeywords)];
  const keywordsHtml = uniqueKeywords
    .map(
      (k) =>
        `<button type="button" class="keyword-tag" data-keyword="${escapeHtml(k)}" title="이 키워드로 법제처 판례 검색">#${escapeHtml(k)} 🔍</button>`
    )
    .join('');

  const issuesHtml = (ai.keyIssues || []).map((issue) => `<li>${escapeHtml(issue)}</li>`).join('');

  const citedHtml = (ai.citedCases || [])
    .map((c) => `<li><strong>${escapeHtml(c.caseNumber)}</strong> — ${escapeHtml(c.relevance)}</li>`)
    .join('');

  const glossaryHtml = (ai.glossary || [])
    .map(
      (g) => `
        <div class="glossary-card">
          <span class="glossary-term">${escapeHtml(g.term)}</span>
          <span class="glossary-meaning">${escapeHtml(g.meaning)}</span>
        </div>
      `
    )
    .join('');

  const matchedCount = Array.isArray(data.matchedPrecedents) ? data.matchedPrecedents.length : 0;
  const totalMatchedText =
    data.totalMatchedCount > matchedCount
      ? `상위 ${matchedCount}건 (법제처 총 ${data.totalMatchedCount.toLocaleString('ko-KR')}건 매칭)`
      : `${matchedCount}건`;

  container.innerHTML = `
    <div class="ai-analysis-card">
      <div class="ai-analysis-header">
        <div class="ai-analysis-title-wrap">
          <span style="font-size: 1.5rem;" aria-hidden="true">💡</span>
          <div>
            <h3>AI 법률 쟁점 분석 (${escapeHtml(levelInfo.badge)} 맞춤)</h3>
            <div class="ai-meta-sub">사건 분류: ${escapeHtml(ai.caseCategory || '민사')} · 검색 키워드: [${escapeHtml(ai.searchKeyword || '')}]${data.fromCache ? ' · ⚡ 캐시 응답' : ''}</div>
          </div>
        </div>
        <span class="ai-source-pill ${isGemini ? 'gemini' : 'fallback'}">${sourceLabel}</span>
      </div>

      <div class="ai-tags-row">
        ${statutesHtml}
        ${keywordsHtml}
      </div>

      <div class="ai-advice-box">
        <strong>📌 ${escapeHtml(levelInfo.label)} 눈높이 대응 조언:</strong><br>${escapeHtml(ai.summaryAdvice || '')}
      </div>

      ${
        ai.easyExample
          ? `<div class="easy-example-card ai-example-box level-${escapeHtml(level)}"><h4>💡 ${escapeHtml(levelInfo.label)} 눈높이 실생활 예시</h4><p>${escapeHtml(ai.easyExample)}</p></div>`
          : ''
      }

      ${
        glossaryHtml
          ? `<div class="glossary-section" style="margin-bottom: 1rem;"><h4>🔑 답변 속 어려운 법률 용어 풀이</h4><div class="glossary-grid">${glossaryHtml}</div></div>`
          : ''
      }

      ${
        citedHtml
          ? `<h4 class="ai-sub-heading">📎 AI가 인용한 법제처 실시간 판례</h4><ul class="ai-cited-list">${citedHtml}</ul>`
          : ''
      }

      ${
        issuesHtml
          ? `<h4 class="ai-sub-heading">🔍 주요 법적 쟁점</h4><ul class="ai-issues-list">${issuesHtml}</ul>`
          : ''
      }
    </div>

    <div class="matched-precedents-header">
      <span>📚 법제처 실시간 매칭 판례 — ${escapeHtml(totalMatchedText)}</span>
      <span class="data-source-badge ${data.isMockPrecedents ? 'featured' : ''}">${data.isMockPrecedents ? '오프라인 데모 판례' : '법제처 실시간 API'}</span>
    </div>
    <div class="precedents-grid" id="ai-matched-precedents-grid"></div>
  `;

  const gridEl = document.getElementById('ai-matched-precedents-grid');
  if (gridEl) {
    renderPrecedentCards(data.matchedPrecedents || [], gridEl);
  }
}

// ---------------------------------------------------------------------------
// 7. 기기별 격리 북마크 관리 (localStorage + 서버 UUID 격리 동기화)
// ---------------------------------------------------------------------------
async function loadBookmarks() {
  try {
    const res = await fetch('/api/bookmarks', { headers: getClientHeaders() });
    const data = await res.json();
    if (res.ok && data.success && Array.isArray(data.bookmarks)) {
      bookmarksList = data.bookmarks;
      localStorage.setItem('lawfinder_bookmarks', JSON.stringify(bookmarksList));
      updateBookmarkBadge();
      return;
    }
  } catch {
    // 오프라인 폴백
  }
  try {
    const local = localStorage.getItem('lawfinder_bookmarks');
    bookmarksList = local ? JSON.parse(local) : [];
  } catch {
    bookmarksList = [];
  }
  updateBookmarkBadge();
}

function isItemBookmarked(precSeq) {
  return bookmarksList.some((b) => String(b.precSeq) === String(precSeq));
}

function updateBookmarkBadge() {
  setText('bookmark-count-badge', String(bookmarksList.length));
  setText('bookmark-total-count', String(bookmarksList.length));
}

async function handleCardBookmarkClick(btnEl, precSeq) {
  if (!precSeq) return;
  const isBookmarked = isItemBookmarked(precSeq);

  if (isBookmarked) {
    await removeBookmark(precSeq);
    showToast('보관함에서 삭제되었습니다.');
  } else {
    try {
      const detailRes = await fetch(`/api/prec/detail?id=${encodeURIComponent(precSeq)}`);
      const detailData = await detailRes.json();
      if (detailRes.ok && detailData.success && detailData.data) {
        await addBookmark(detailData.data);
        showToast('관심 판례 보관함에 저장되었습니다.');
      } else {
        showToast('판례 정보를 가져오지 못했습니다.');
      }
    } catch {
      showToast('저장 중 네트워크 오류가 발생했습니다.');
    }
  }

  if (currentTab === 'bookmarks') {
    renderBookmarksView();
  } else {
    const nowBookmarked = isItemBookmarked(precSeq);
    btnEl.classList.toggle('active', nowBookmarked);
    btnEl.textContent = nowBookmarked ? '★' : '☆';
  }
}

async function toggleModalBookmark() {
  if (!currentModalPrecedent) return;
  const precSeq = currentModalPrecedent.precSeq;
  if (isItemBookmarked(precSeq)) {
    await removeBookmark(precSeq);
    showToast('보관함에서 삭제되었습니다.');
  } else {
    await addBookmark(currentModalPrecedent);
    showToast('관심 판례 보관함에 저장되었습니다.');
  }
  updateModalBookmarkButton();
}

function updateModalBookmarkButton() {
  const btn = document.getElementById('modal-bookmark-toggle-btn');
  if (!btn || !currentModalPrecedent) return;
  const bookmarked = isItemBookmarked(currentModalPrecedent.precSeq);
  btn.textContent = bookmarked ? '★ 보관됨' : '☆ 보관';
}

async function addBookmark(item) {
  if (!isItemBookmarked(item.precSeq)) {
    bookmarksList.unshift(item);
    localStorage.setItem('lawfinder_bookmarks', JSON.stringify(bookmarksList));
    updateBookmarkBadge();
  }
  try {
    await fetch('/api/bookmarks', {
      method: 'POST',
      headers: getClientHeaders({ 'Content-Type': 'application/json' }),
      body: JSON.stringify(item)
    });
  } catch {
    // 오프라인 시 localStorage 유지
  }
}

async function removeBookmark(precSeq) {
  bookmarksList = bookmarksList.filter((b) => String(b.precSeq) !== String(precSeq));
  localStorage.setItem('lawfinder_bookmarks', JSON.stringify(bookmarksList));
  updateBookmarkBadge();
  try {
    await fetch(`/api/bookmarks/${encodeURIComponent(precSeq)}`, {
      method: 'DELETE',
      headers: getClientHeaders()
    });
  } catch {
    // 오프라인 시 localStorage 유지
  }
}

function renderBookmarksView() {
  const container = document.getElementById('bookmarks-list-container');
  if (!container) return;
  if (bookmarksList.length === 0) {
    container.innerHTML = `<div class="empty-state"><span class="empty-icon">⭐</span>저장된 관심 판례가 없습니다.<br>판례 검색이나 AI 질문 결과에서 관심 판례의 별표(☆)를 눌러 저장해 보세요.</div>`;
    return;
  }
  renderPrecedentCards(bookmarksList, container);
}

// ---------------------------------------------------------------------------
// 8. PWA 설치 유도 및 서비스 워커 등록 (지침 제15원칙)
// ---------------------------------------------------------------------------
function showPwaInstallControls() {
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  if (isStandalone) return;

  const modalBox = document.getElementById('pwa-native-install-box');
  if (modalBox) modalBox.hidden = false;

  if (sessionStorage.getItem('lawfinder_pwa_banner_dismissed') !== '1') {
    const banner = document.getElementById('pwa-install-banner');
    if (banner) banner.hidden = false;
  }
}

async function triggerPwaInstall() {
  if (deferredInstallPrompt) {
    deferredInstallPrompt.prompt();
    const { outcome } = await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    if (outcome === 'accepted') {
      closeModalById('modalPwaGuide');
    }
    return;
  }
  openModalById('modalPwaGuide');
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    });
  }
}

// ---------------------------------------------------------------------------
// 9. 실시간 버전 감지·자동 캐시 갱신 & What's New 보고창 (지침 제16원칙)
// ---------------------------------------------------------------------------
function isServerVersionNewer(serverVer, clientVer) {
  const s = String(serverVer || '0.0.0').split('.').map(Number);
  const c = String(clientVer || '0.0.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((s[i] || 0) > (c[i] || 0)) return true;
    if ((s[i] || 0) < (c[i] || 0)) return false;
  }
  return false;
}

async function checkAppVersionUpdate() {
  if (versionCheckRunning) return;
  versionCheckRunning = true;
  try {
    const res = await fetch(`/api/version?_t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const meta = await res.json();
    if (meta && meta.version && isServerVersionNewer(meta.version, CLIENT_VERSION)) {
      await forcePageReload(meta.version);
    }
  } catch {
    // 네트워크 오프라인 무시
  } finally {
    versionCheckRunning = false;
  }
}

async function forcePageReload(serverVersion) {
  const guardKey = `auto_reload_to_${serverVersion}`;
  const lastAttempt = Number(sessionStorage.getItem(guardKey) || '0');
  if (Date.now() - lastAttempt < 60 * 1000) {
    return;
  }
  sessionStorage.setItem(guardKey, String(Date.now()));
  showToast(`🚀 새 버전(v${serverVersion})으로 업데이트되었습니다. 최신 화면으로 새로고침합니다...`);

  try {
    if ('caches' in window) {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    // ignore
  }

  setTimeout(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('_v', serverVersion);
    url.searchParams.set('_t', String(Date.now()));
    window.location.replace(url.toString());
  }, 900);
}

async function checkWhatsNewPopup() {
  const dismissed = localStorage.getItem('dismissed_update_version');
  if (dismissed === CLIENT_VERSION) return;

  try {
    const res = await fetch(`/api/version?_t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const meta = await res.json();
    if (!meta || !meta.releaseNotes) return;

    setText('whatsnew-version-badge', `v${meta.version || CLIENT_VERSION}`);
    setText('whatsnew-build-badge', `빌드 ${meta.build || ''}`);
    setText('whatsnew-summary', meta.releaseNotes);

    const listEl = document.getElementById('whatsnew-features');
    if (listEl && Array.isArray(meta.features)) {
      listEl.innerHTML = meta.features
        .map(
          (f) => `
            <div class="whatsnew-feature-card">
              <strong>${escapeHtml(f.icon || '✨')} ${escapeHtml(f.title || '')}</strong>
              <p>${escapeHtml(f.desc || '')}</p>
            </div>
          `
        )
        .join('');
    }
    openModalById('modalWhatsNew');
  } catch {
    // 오프라인 시 무시
  }
}

// ---------------------------------------------------------------------------
// 10. 모바일 BFCache 및 라이프사이클 대응 (지침 제5원칙)
// ---------------------------------------------------------------------------
function setupMobileLifecycle() {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      checkServerHealth();
      loadBookmarks();
      checkAppVersionUpdate();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkServerHealth();
      checkAppVersionUpdate();
    }
  });

  window.addEventListener('focus', () => {
    checkAppVersionUpdate();
  });
}

// ---------------------------------------------------------------------------
// 11. 유틸리티
// ---------------------------------------------------------------------------
function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function showToast(msg) {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast';
  toast.textContent = msg;
  container.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transition = 'opacity 0.3s';
    setTimeout(() => toast.remove(), 300);
  }, 2600);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
