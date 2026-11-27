/**
 * LawFinder - Client Application Logic
 */

// 전역 상태
let currentTab = 'search';
let currentSearchQuery = '';
let currentSearchScope = '1';
let currentPage = 1;
let currentModalPrecedent = null;
let bookmarksList = [];

// 초기화
document.addEventListener('DOMContentLoaded', () => {
  initApp();
  registerServiceWorker();
  setupMobileLifecycle();
});

async function initApp() {
  await checkServerHealth();
  await loadBookmarks();
  executeSearch(1); // 기본 추천 판례 로드

  // 검색 엔터키 리스너
  const searchInput = document.getElementById('search-query-input');
  if (searchInput) {
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        executeSearch(1);
      }
    });
  }

  // AI 텍스트에어리어 Ctrl+Enter / Cmd+Enter 리스너
  const aiInput = document.getElementById('ai-question-input');
  if (aiInput) {
    aiInput.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        executeAiAsk();
      }
    });
  }
}

/**
 * 1. 서버 상태 점검
 */
async function checkServerHealth() {
  const statusEl = document.getElementById('server-status');
  try {
    const res = await fetch('/api/health');
    const data = await res.json();
    if (data.status === 'ok') {
      const modeText = data.law_oc_configured ? '공공 API 연동됨' : 'Mock 모드';
      const aiText = data.gemini_configured ? 'Gemini AI 연동됨' : '규칙기반 NLP';
      statusEl.innerHTML = `<span class="status-dot"></span><span class="status-text">${modeText} | ${aiText}</span>`;
      statusEl.title = `서버 가동 중 (KST: ${data.timeKST})`;
    }
  } catch (err) {
    statusEl.innerHTML = `<span class="status-dot" style="background-color:#ef4444"></span><span class="status-text">서버 연결 오류</span>`;
  }
}

/**
 * 2. 탭 전환
 */
function switchTab(tabName) {
  currentTab = tabName;
  document.querySelectorAll('.nav-tab').forEach(btn => btn.classList.remove('active'));
  document.querySelectorAll('.tab-view').forEach(view => view.classList.remove('active'));

  const activeBtn = document.getElementById(`tab-btn-${tabName}`);
  const activeView = document.getElementById(`view-${tabName}`);
  if (activeBtn) activeBtn.classList.add('active');
  if (activeView) activeView.classList.add('active');

  if (tabName === 'bookmarks') {
    renderBookmarksView();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/**
 * 3. 판례 검색 실행
 */
async function executeSearch(page = 1) {
  const queryInput = document.getElementById('search-query-input');
  const query = queryInput ? queryInput.value.trim() : '';
  const searchScope = document.querySelector('input[name="searchScope"]:checked')?.value || '1';

  currentSearchQuery = query;
  currentSearchScope = searchScope;
  currentPage = page;

  const loadingEl = document.getElementById('search-loading');
  const containerEl = document.getElementById('precedents-list-container');
  const metaBar = document.getElementById('search-results-meta');
  const totalCountEl = document.getElementById('total-count-num');
  const badgeEl = document.getElementById('data-source-badge');

  loadingEl.style.display = 'block';
  containerEl.innerHTML = '';
  metaBar.style.display = 'none';

  try {
    const url = `/api/prec/search?query=${encodeURIComponent(query)}&search=${searchScope}&page=${page}&display=15`;
    const res = await fetch(url);
    const data = await res.json();

    loadingEl.style.display = 'none';

    if (data.success && data.items) {
      metaBar.style.display = 'flex';
      totalCountEl.textContent = data.totalCount || data.items.length;
      badgeEl.textContent = data.isMock ? '대표 판례 데이터셋 (오프라인 모드)' : '법제처 국가법령정보 실시간 연동';
      badgeEl.style.color = data.isMock ? '#fbbf24' : '#34d399';

      renderPrecedentCards(data.items, containerEl);
    } else {
      containerEl.innerHTML = `<div class="empty-state" style="text-align:center; padding:3rem; color:#94a3b8;">검색 결과가 없습니다. 다른 검색어를 시도해 보세요.</div>`;
    }
  } catch (err) {
    loadingEl.style.display = 'none';
    containerEl.innerHTML = `<div class="error-state" style="text-align:center; padding:3rem; color:#f87171;">판례 검색 중 오류가 발생했습니다: ${err.message}</div>`;
  }
}

function handleScopeChange() {
  executeSearch(1);
}

function quickSearch(keyword) {
  const input = document.getElementById('search-query-input');
  if (input) {
    input.value = keyword;
    executeSearch(1);
  }
}

/**
 * 4. 판례 카드 목록 렌더링
 */
function renderPrecedentCards(items, targetContainer) {
  if (!items || items.length === 0) {
    targetContainer.innerHTML = `<div class="empty-state" style="text-align:center; padding:3rem; color:#94a3b8;">표시할 판례가 없습니다.</div>`;
    return;
  }

  targetContainer.innerHTML = items.map(item => {
    const isBookmarked = isItemBookmarked(item.precSeq);
    const summaryText = item.holding || item.summary || '상세 보기에서 전문과 요지를 확인하세요.';
    
    return `
      <article class="precedent-card" onclick="openDetailModal('${item.precSeq}')">
        <div class="card-header-row">
          <div class="card-badges">
            <span class="badge-tag badge-court">${escapeHtml(item.courtName || '법원')}</span>
            <span class="badge-tag badge-type">${escapeHtml(item.caseType || '민사')}</span>
            <span class="badge-tag badge-date">${escapeHtml(item.judgDate || '')}</span>
          </div>
          <button class="card-bookmark-btn ${isBookmarked ? 'active' : ''}" 
                  onclick="handleCardBookmarkClick(event, '${item.precSeq}')" 
                  title="보관함 저장">
            ${isBookmarked ? '★' : '☆'}
          </button>
        </div>

        <h3 class="card-title">${escapeHtml(item.caseName || '판례')}</h3>
        <div class="card-case-number">${escapeHtml(item.caseNumber || '')} ${item.judgType ? `[${item.judgType}]` : ''}</div>
        
        <p class="card-summary-preview">${escapeHtml(summaryText)}</p>

        <div class="card-footer-row">
          <span>클릭하여 상세 판결문 보기</span>
          <button class="card-view-detail-btn">
            전문 확인 ➔
          </button>
        </div>
      </article>
    `;
  }).join('');
}

/**
 * 5. 판례 상세 모달 열기
 */
async function openDetailModal(precSeq) {
  const modal = document.getElementById('detail-modal');
  modal.classList.add('active');
  document.body.style.overflow = 'hidden';

  // 로딩 플레이스홀더
  document.getElementById('modal-case-name').textContent = '판례 불러오는 중...';
  document.getElementById('modal-case-number').textContent = '';
  document.getElementById('modal-court-name').textContent = '-';
  document.getElementById('modal-case-type').textContent = '-';
  document.getElementById('modal-judg-date').textContent = '-';
  document.getElementById('modal-holding-text').textContent = '데이터를 조회하고 있습니다...';
  document.getElementById('modal-summary-text').textContent = '데이터를 조회하고 있습니다...';
  document.getElementById('modal-statute-text').textContent = '데이터를 조회하고 있습니다...';
  document.getElementById('modal-precedent-text').textContent = '데이터를 조회하고 있습니다...';
  document.getElementById('modal-full-content').textContent = '데이터를 조회하고 있습니다...';

  switchDetailTab('holding');

  try {
    const res = await fetch(`/api/prec/detail?id=${encodeURIComponent(precSeq)}`);
    const result = await res.json();

    if (result.success && result.data) {
      const data = result.data;
      currentModalPrecedent = data;

      document.getElementById('modal-case-name').textContent = data.caseName || '판례';
      document.getElementById('modal-case-number').textContent = `${data.caseNumber || ''} ${data.judgType ? `[${data.judgType}]` : ''}`;
      document.getElementById('modal-court-name').textContent = data.courtName || '-';
      document.getElementById('modal-case-type').textContent = data.caseType || '-';
      document.getElementById('modal-judg-date').textContent = data.judgDate || '-';

      document.getElementById('modal-holding-text').textContent = data.holding || '등록된 판시사항이 없습니다.';
      document.getElementById('modal-summary-text').textContent = data.summary || '등록된 판결요지가 없습니다.';
      document.getElementById('modal-statute-text').textContent = data.refStatute || '등록된 참조조문 정보가 없습니다.';
      document.getElementById('modal-precedent-text').textContent = data.refPrecedent || '등록된 참조판례 정보가 없습니다.';
      document.getElementById('modal-full-content').textContent = data.content || data.summary || '전문 정보가 없습니다.';

      updateModalBookmarkButton();
    } else {
      document.getElementById('modal-holding-text').textContent = '판례 정보를 불러오지 못했습니다.';
    }
  } catch (err) {
    document.getElementById('modal-holding-text').textContent = `오류 발생: ${err.message}`;
  }
}

function switchDetailTab(tabName) {
  document.querySelectorAll('.modal-tab').forEach(b => b.classList.remove('active'));
  document.querySelectorAll('.detail-tab-pane').forEach(p => p.classList.remove('active'));

  const tabIndex = { holding: 0, summary: 1, statute: 2, content: 3 }[tabName] || 0;
  const buttons = document.querySelectorAll('.modal-tab');
  if (buttons[tabIndex]) buttons[tabIndex].classList.add('active');

  const pane = document.getElementById(`modal-tab-${tabName}`);
  if (pane) pane.classList.add('active');
}

function closeDetailModal(event) {
  if (event.target === document.getElementById('detail-modal')) {
    closeDetailModalDirect();
  }
}

function closeDetailModalDirect() {
  document.getElementById('detail-modal').classList.remove('active');
  document.body.style.overflow = '';
}

function copyModalContent() {
  if (!currentModalPrecedent) return;
  const text = `[판례정보]\n사건명: ${currentModalPrecedent.caseName}\n사건번호: ${currentModalPrecedent.caseNumber}\n법원/선고일: ${currentModalPrecedent.courtName} (${currentModalPrecedent.judgDate})\n\n【판시사항】\n${currentModalPrecedent.holding}\n\n【판결요지】\n${currentModalPrecedent.summary}\n\n【참조조문】\n${currentModalPrecedent.refStatute}`;
  
  navigator.clipboard.writeText(text).then(() => {
    showToast('판례 내용이 클립보드에 복사되었습니다.');
  }).catch(() => {
    showToast('복사에 실패했습니다.');
  });
}

/**
 * 6. AI 법률 질문 & RAG 질의응답
 */
function fillAiQuestion(q) {
  const textarea = document.getElementById('ai-question-input');
  if (textarea) {
    textarea.value = q;
    textarea.focus();
  }
}

async function executeAiAsk() {
  const textarea = document.getElementById('ai-question-input');
  const question = textarea ? textarea.value.trim() : '';

  if (!question) {
    showToast('질문 내용을 먼저 입력해 주세요.');
    return;
  }

  const loadingEl = document.getElementById('ai-loading');
  const resultWrap = document.getElementById('ai-result-container');
  const submitBtn = document.getElementById('ai-submit-btn');

  loadingEl.style.display = 'block';
  resultWrap.style.display = 'none';
  resultWrap.innerHTML = '';
  submitBtn.disabled = true;

  try {
    const res = await fetch('/api/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question })
    });
    const data = await res.json();

    loadingEl.style.display = 'none';
    submitBtn.disabled = false;

    if (data.success && data.aiAnalysis) {
      resultWrap.style.display = 'block';
      renderAiAnalysisResult(data, resultWrap);
      resultWrap.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      showToast('AI 분석에 실패했습니다. 다시 시도해 주세요.');
    }
  } catch (err) {
    loadingEl.style.display = 'none';
    submitBtn.disabled = false;
    showToast(`분석 중 오류 발생: ${err.message}`);
  }
}

function renderAiAnalysisResult(data, container) {
  const ai = data.aiAnalysis;
  const statutesHtml = (ai.relatedStatutes || []).map(s => `<span class="statute-tag">📜 ${escapeHtml(s)}</span>`).join('');
  const subKeywordsHtml = (ai.subKeywords || []).map(k => `<span class="keyword-tag">#${escapeHtml(k)}</span>`).join('');
  const issuesHtml = (ai.keyIssues || []).map(issue => `<li>${escapeHtml(issue)}</li>`).join('');

  container.innerHTML = `
    <div class="ai-analysis-card">
      <div class="ai-analysis-header">
        <span style="font-size: 1.5rem;">💡</span>
        <div>
          <h3>AI 법률 쟁점 분석 & 행동 요령</h3>
          <span style="font-size: 0.8rem; color: #94a3b8;">사건 분류: ${escapeHtml(ai.caseCategory || '민사')} | 핵심 키워드: [${escapeHtml(ai.searchKeyword || '')}]</span>
        </div>
      </div>

      <div class="ai-tags-row">
        ${statutesHtml}
        ${subKeywordsHtml}
      </div>

      <div class="ai-advice-box">
        <strong>📌 맞춤형 대처 조언:</strong><br>
        ${escapeHtml(ai.summaryAdvice || '')}
      </div>

      ${issuesHtml ? `
        <div style="margin-top: 1rem;">
          <h4 style="font-size: 0.9rem; color: #94a3b8; margin-bottom: 0.5rem;">🔍 주요 법적 쟁점:</h4>
          <ul class="ai-issues-list">${issuesHtml}</ul>
        </div>
      ` : ''}
    </div>

    <div class="matched-precedents-header">
      <span>📚 관련 추천 판례 (${data.matchedPrecedents ? data.matchedPrecedents.length : 0}건)</span>
    </div>
    <div class="precedents-grid" id="ai-matched-precedents-grid"></div>
  `;

  const gridEl = document.getElementById('ai-matched-precedents-grid');
  if (gridEl && data.matchedPrecedents) {
    renderPrecedentCards(data.matchedPrecedents, gridEl);
  }
}

/**
 * 7. 북마크(보관함) 관리
 */
async function loadBookmarks() {
  try {
    const res = await fetch('/api/bookmarks');
    const data = await res.json();
    if (data.success && data.bookmarks) {
      bookmarksList = data.bookmarks;
      updateBookmarkBadge();
    }
  } catch (err) {
    console.warn('Bookmarks load error, fallback to localstorage');
    const local = localStorage.getItem('lawfinder_bookmarks');
    if (local) bookmarksList = JSON.parse(local);
    updateBookmarkBadge();
  }
}

function isItemBookmarked(precSeq) {
  return bookmarksList.some(b => String(b.precSeq) === String(precSeq));
}

function updateBookmarkBadge() {
  const badge = document.getElementById('bookmark-count-badge');
  const total = document.getElementById('bookmark-total-count');
  if (badge) badge.textContent = bookmarksList.length;
  if (total) total.textContent = bookmarksList.length;
}

async function handleCardBookmarkClick(event, precSeq) {
  event.stopPropagation();
  const isBookmarked = isItemBookmarked(precSeq);

  if (isBookmarked) {
    // 삭제
    await removeBookmark(precSeq);
    showToast('보관함에서 삭제되었습니다.');
  } else {
    // 추가
    try {
      const detailRes = await fetch(`/api/prec/detail?id=${encodeURIComponent(precSeq)}`);
      const detailData = await detailRes.json();
      if (detailData.success && detailData.data) {
        await addBookmark(detailData.data);
        showToast('관심 판례에 저장되었습니다.');
      }
    } catch (e) {
      showToast('저장 중 오류가 발생했습니다.');
    }
  }

  // 화면 갱신
  if (currentTab === 'bookmarks') {
    renderBookmarksView();
  } else {
    const btn = event.currentTarget;
    const nowBookmarked = isItemBookmarked(precSeq);
    btn.classList.toggle('active', nowBookmarked);
    btn.textContent = nowBookmarked ? '★' : '☆';
  }
}

async function toggleModalBookmark() {
  if (!currentModalPrecedent) return;
  const precSeq = currentModalPrecedent.precSeq;
  const isBookmarked = isItemBookmarked(precSeq);

  if (isBookmarked) {
    await removeBookmark(precSeq);
    showToast('보관함에서 삭제되었습니다.');
  } else {
    await addBookmark(currentModalPrecedent);
    showToast('관심 판례에 저장되었습니다.');
  }
  updateModalBookmarkButton();
}

function updateModalBookmarkButton() {
  const btn = document.getElementById('modal-bookmark-toggle-btn');
  if (!btn || !currentModalPrecedent) return;
  const isBookmarked = isItemBookmarked(currentModalPrecedent.precSeq);
  btn.textContent = isBookmarked ? '★ 보관됨' : '☆ 보관함 저장';
  btn.style.color = isBookmarked ? '#fbbf24' : '';
}

async function addBookmark(item) {
  bookmarksList.unshift(item);
  localStorage.setItem('lawfinder_bookmarks', JSON.stringify(bookmarksList));
  updateBookmarkBadge();
  try {
    await fetch('/api/bookmarks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item)
    });
  } catch (err) {}
}

async function removeBookmark(precSeq) {
  bookmarksList = bookmarksList.filter(b => String(b.precSeq) !== String(precSeq));
  localStorage.setItem('lawfinder_bookmarks', JSON.stringify(bookmarksList));
  updateBookmarkBadge();
  try {
    await fetch(`/api/bookmarks/${encodeURIComponent(precSeq)}`, { method: 'DELETE' });
  } catch (err) {}
}

function renderBookmarksView() {
  const container = document.getElementById('bookmarks-list-container');
  if (!container) return;
  if (bookmarksList.length === 0) {
    container.innerHTML = `<div class="empty-state" style="text-align:center; padding:4rem 1rem; color:#94a3b8;">
      <span style="font-size:2.5rem; display:block; margin-bottom:1rem;">⭐</span>
      저장된 관심 판례가 없습니다.<br>판례 검색이나 AI 질문 결과에서 관심 있는 판례를 저장해 보세요.
    </div>`;
    return;
  }
  renderPrecedentCards(bookmarksList, container);
}

/**
 * 8. 모바일 BFCache 및 라이프사이클 대응
 */
function setupMobileLifecycle() {
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
      checkServerHealth();
      loadBookmarks();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkServerHealth();
    }
  });
}

/**
 * 9. PWA 서비스 워커 등록
 */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    });
  }
}

/**
 * 10. 유틸리티 (토스트 & HTML 이스케이프)
 */
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
  }, 2500);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
