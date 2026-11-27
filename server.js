const express = require('express');
const path = require('path');
const fs = require('fs');
const { XMLParser } = require('fast-xml-parser');
const { MOCK_PRECEDENTS } = require('./mock_data');

const app = express();
const PORT = process.env.PORT || 80;
const LAW_OC = process.env.LAW_OC || '';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';

// 데이터 디렉토리 및 영구 저장소 보장
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
const BOOKMARKS_FILE = path.join(DATA_DIR, 'bookmarks.json');
const CACHE_FILE = path.join(DATA_DIR, 'prec_cache.json');

// 북마크 초기화
if (!fs.existsSync(BOOKMARKS_FILE)) {
  fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify([]), 'utf8');
}

// 인메모리 캐시 초기화
const memoryCache = new Map();

// XML 파서 설정
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  trimValues: true
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    // PWA 및 정적 파일 무캐시 표준 적용
    if (filePath.endsWith('manifest.json') || filePath.endsWith('sw.js')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

// KST 날짜 포맷터 (지침 준수)
function getKSTDateString(date = new Date()) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).format(date);
}

// 법률 텍스트 클리닝 헬퍼
function cleanLawText(raw) {
  if (!raw) return '';
  if (typeof raw !== 'string') raw = String(raw);
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p.*?>/gi, '')
    .replace(/<\/p>/gi, '\n')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .replace(/<[^>]+>/g, '') // 잔여 태그 제거
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 1. 헬스체크 및 환경 설정 상태
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'law-finder',
    version: '1.0.0',
    timeKST: getKSTDateString(),
    law_oc_configured: Boolean(LAW_OC && LAW_OC.trim() !== ''),
    gemini_configured: Boolean(GEMINI_API_KEY && GEMINI_API_KEY.trim() !== ''),
    cachedItemsCount: memoryCache.size
  });
});

/**
 * 2. 판례 목록 검색 API
 * GET /api/prec/search?query=...&search=1&page=1&display=20
 */
app.get('/api/prec/search', async (req, res) => {
  const query = (req.query.query || '').trim();
  const searchScope = req.query.search || '1'; // 1: 판례명, 2: 본문
  const page = parseInt(req.query.page || '1', 10);
  const display = parseInt(req.query.display || '20', 10);

  if (!query) {
    // 쿼리가 없을 경우 추천 기본 판례 반환
    return res.json({
      success: true,
      totalCount: MOCK_PRECEDENTS.length,
      page: 1,
      display,
      isMock: true,
      items: MOCK_PRECEDENTS.map(p => ({
        precSeq: p.precSeq,
        caseName: p.caseName,
        caseNumber: p.caseNumber,
        judgDate: p.judgDate,
        courtName: p.courtName,
        caseType: p.caseType,
        judgType: p.judgType,
        holding: p.holding,
        summary: p.summary,
        category: p.category
      }))
    });
  }

  const cacheKey = `search:${query}:${searchScope}:${page}:${display}`;
  if (memoryCache.has(cacheKey)) {
    return res.json(memoryCache.get(cacheKey));
  }

  // 1) 법제처 Open API 호출 시도
  if (LAW_OC && LAW_OC.trim() !== '') {
    try {
      const url = `http://www.law.go.kr/DRF/lawSearch.do?target=prec&OC=${encodeURIComponent(LAW_OC)}&type=XML&query=${encodeURIComponent(query)}&search=${searchScope}&page=${page}&display=${display}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(6000) });
      
      if (response.ok) {
        const xmlText = await response.text();
        const parsed = xmlParser.parse(xmlText);
        
        if (parsed && parsed.PrecSearch) {
          const totalCount = parseInt(parsed.PrecSearch.totalCnt || '0', 10);
          let rawList = parsed.PrecSearch.prec || [];
          if (!Array.isArray(rawList) && rawList.판례일련번호) {
            rawList = [rawList];
          }

          const items = (Array.isArray(rawList) ? rawList : []).map(p => ({
            precSeq: String(p.판례일련번호 || ''),
            caseName: cleanLawText(p.사건명 || ''),
            caseNumber: cleanLawText(p.사건번호 || ''),
            judgDate: cleanLawText(p.선고일자 || ''),
            courtName: cleanLawText(p.법원명 || ''),
            caseType: cleanLawText(p.사건종류명 || ''),
            judgType: cleanLawText(p.판결유형 || ''),
            holding: cleanLawText(p.판시사항 || ''),
            summary: cleanLawText(p.판결요지 || ''),
            precLink: p.판례상세링크 || ''
          }));

          const result = {
            success: true,
            totalCount,
            page,
            display,
            isMock: false,
            items
          };

          memoryCache.set(cacheKey, result);
          return res.json(result);
        }
      }
    } catch (err) {
      console.warn(`[LawAPI Warning] Fetch failed (${err.message}), falling back to intelligent mock`);
    }
  }

  // 2) Fallback: Mock 데이터베이스 지능형 필터링
  const lowerQuery = query.toLowerCase();
  const matched = MOCK_PRECEDENTS.filter(p => {
    return (
      p.caseName.toLowerCase().includes(lowerQuery) ||
      p.caseNumber.toLowerCase().includes(lowerQuery) ||
      p.holding.toLowerCase().includes(lowerQuery) ||
      p.summary.toLowerCase().includes(lowerQuery) ||
      p.refStatute.toLowerCase().includes(lowerQuery) ||
      p.category.toLowerCase().includes(lowerQuery)
    );
  });

  const result = {
    success: true,
    totalCount: matched.length > 0 ? matched.length : MOCK_PRECEDENTS.length,
    page: 1,
    display,
    isMock: true,
    items: (matched.length > 0 ? matched : MOCK_PRECEDENTS).slice(0, display)
  };

  memoryCache.set(cacheKey, result);
  res.json(result);
});

/**
 * 3. 판례 상세 본문 조회 API
 * GET /api/prec/detail?id=219842
 */
app.get('/api/prec/detail', async (req, res) => {
  const id = (req.query.id || '').trim();
  if (!id) {
    return res.status(400).json({ success: false, error: '판례일련번호(id)가 필요합니다.' });
  }

  const cacheKey = `detail:${id}`;
  if (memoryCache.has(cacheKey)) {
    return res.json(memoryCache.get(cacheKey));
  }

  // 1) 법제처 Open API 상세 호출 시도
  if (LAW_OC && LAW_OC.trim() !== '') {
    try {
      const url = `http://www.law.go.kr/DRF/lawService.do?target=prec&OC=${encodeURIComponent(LAW_OC)}&ID=${encodeURIComponent(id)}&type=XML`;
      const response = await fetch(url, { signal: AbortSignal.timeout(6000) });

      if (response.ok) {
        const xmlText = await response.text();
        const parsed = xmlParser.parse(xmlText);

        if (parsed && parsed.PrecService) {
          const p = parsed.PrecService;
          const detail = {
            success: true,
            isMock: false,
            data: {
              precSeq: String(p.판례일련번호 || id),
              caseName: cleanLawText(p.사건명 || ''),
              caseNumber: cleanLawText(p.사건번호 || ''),
              judgDate: cleanLawText(p.선고일자 || ''),
              courtName: cleanLawText(p.법원명 || ''),
              caseType: cleanLawText(p.사건종류명 || ''),
              judgType: cleanLawText(p.판결유형 || ''),
              holding: cleanLawText(p.판시사항 || ''),
              summary: cleanLawText(p.판결요지 || ''),
              refStatute: cleanLawText(p.참조조문 || ''),
              refPrecedent: cleanLawText(p.참조판례 || ''),
              content: cleanLawText(p.판례내용 || p.판례문 || '')
            }
          };

          memoryCache.set(cacheKey, detail);
          return res.json(detail);
        }
      }
    } catch (err) {
      console.warn(`[LawAPI Detail Warning] Fetch failed (${err.message}), falling back to mock`);
    }
  }

  // 2) Fallback: Mock 데이터셋 검색
  const mockItem = MOCK_PRECEDENTS.find(p => p.precSeq === id);
  if (mockItem) {
    const detail = {
      success: true,
      isMock: true,
      data: {
        precSeq: mockItem.precSeq,
        caseName: mockItem.caseName,
        caseNumber: mockItem.caseNumber,
        judgDate: mockItem.judgDate,
        courtName: mockItem.courtName,
        caseType: mockItem.caseType,
        judgType: mockItem.judgType,
        holding: mockItem.holding,
        summary: mockItem.summary,
        refStatute: mockItem.refStatute,
        refPrecedent: mockItem.refPrecedent,
        content: `【주 문】\n원심판결을 파기하고, 사건을 해당 지방법원 합의부에 환송한다.\n\n【이 유】\n상고이유를 판단한다.\n\n1. 사건의 경위 및 원심의 판단\n원심 판결 이유에 의하면, 원고는 피고와 체결된 계약에 기하여 의무를 모두 이행하였음에도 피고가 정당한 사유 없이 자신의 의무 이행을 지체하고 있는 바...\n\n2. 대법원의 판단\n${mockItem.summary}\n\n따라서 원심판결에는 법리를 오해하여 판결에 영향을 미친 잘못이 있다. 이를 지적하는 상고이유 주장은 이유 있다.\n\n그러므로 원심판결을 파기하고, 사건을 다시 심리·판단하도록 원심법원에 환송하기로 하여, 관여 대법관의 일치된 의견으로 주문과 같이 판결한다.`
      }
    };
    memoryCache.set(cacheKey, detail);
    return res.json(detail);
  }

  res.status(404).json({ success: false, error: '해당 판례를 찾을 수 없습니다.' });
});

/**
 * 4. AI 하이브리드 법률 질의응답 (Q&A & RAG)
 * POST /api/ask
 * Body: { question: "전세 만기인데 집주인이 연락이 안 돼요" }
 */
app.post('/api/ask', async (req, res) => {
  const question = (req.body.question || '').trim();
  if (!question) {
    return res.status(400).json({ success: false, error: '질문 내용을 입력해 주세요.' });
  }

  let aiAnalysis = null;

  // 1) Gemini AI 호출 시도
  if (GEMINI_API_KEY && GEMINI_API_KEY.trim() !== '') {
    try {
      const prompt = `당신은 대한민국 법률 전문가이자 대국민 법률 도우미입니다.
아래 사용자의 일상 언어/질문을 분석하여 판례 검색용 법률 키워드와 적용 법조문, 그리고 알기 쉬운 조언을 제공해 주세요.

[사용자 질문]:
"${question}"

반드시 아래 JSON 형식으로만 응답하세요. 백틱(markdown)이나 다른 설명 없이 순수 JSON만 출력하세요:
{
  "searchKeyword": "법제처 판례 검색에 가장 적합한 핵심 법률 키워드 1개 (예: 임대차보증금, 층간소음, 사기)",
  "subKeywords": ["연관 법률 키워드 1", "연관 법률 키워드 2"],
  "relatedStatutes": ["관련 법률 및 예상 조문 (예: 주택임대차보호법 제3조, 민법 제750조)"],
  "caseCategory": "민사 / 형사 / 가사 / 행정 중 하나",
  "summaryAdvice": "일반인이 즉시 이해할 수 있는 핵심 조언 및 해결 절차 (3~4문장)",
  "keyIssues": ["핵심 법적 쟁점 1", "핵심 법적 쟁점 2"]
}`;

      // Gemini 2.0 Flash 또는 1.5 Flash 모델 시도
      const modelEndpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`;
      const aiResponse = await fetch(modelEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
        }),
        signal: AbortSignal.timeout(8000)
      });

      if (aiResponse.ok) {
        const aiData = await aiResponse.json();
        const rawText = aiData?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (rawText) {
          aiAnalysis = JSON.parse(rawText);
        }
      }
    } catch (err) {
      console.warn(`[Gemini Warning] AI call failed (${err.message}), using rule-based NLP fallback`);
    }
  }

  // 2) AI 미설정 또는 호출 실패 시 정교한 규칙 기반 NLP 도출
  if (!aiAnalysis) {
    aiAnalysis = generateRuleBasedLegalAnalysis(question);
  }

  // 3) 도출된 핵심 키워드로 즉시 판례 검색 연동
  const searchKeyword = aiAnalysis.searchKeyword || '손해배상';
  const lowerKeyword = searchKeyword.toLowerCase();
  
  // 모의 및 실서버 판례 매칭
  const matchedPrecedents = MOCK_PRECEDENTS.filter(p => {
    return (
      p.caseName.toLowerCase().includes(lowerKeyword) ||
      p.holding.toLowerCase().includes(lowerKeyword) ||
      p.summary.toLowerCase().includes(lowerKeyword) ||
      p.refStatute.toLowerCase().includes(lowerKeyword) ||
      p.category.toLowerCase().includes(lowerKeyword)
    );
  });

  res.json({
    success: true,
    question,
    aiAnalysis,
    matchedPrecedents: matchedPrecedents.length > 0 ? matchedPrecedents : MOCK_PRECEDENTS.slice(0, 3),
    disclaimer: '본 서비스에서 제공하는 판례 및 AI 분석 내용은 참고용 법률 정보이며, 법적 효력이 있는 공식 법률 자문이 아닙니다. 실제 분쟁 시에는 변호사나 법률구조공단(국번없이 132) 등 전문가의 도움을 받으시기 바랍니다.'
  });
});

/**
 * 규칙 기반 자연어 질문 분석기 (AI Fallback)
 */
function generateRuleBasedLegalAnalysis(q) {
  const text = q.toLowerCase();

  if (text.includes('전세') || text.includes('보증금') || text.includes('월세') || text.includes('임대차') || text.includes('집주인')) {
    return {
      searchKeyword: '임대차보증금',
      subKeywords: ['주택임대차보호법', '임차권등기명령', '우선변제권'],
      relatedStatutes: ['주택임대차보호법 제3조(대항력)', '주택임대차보호법 제3조의2(우선변제권)', '민법 제317조'],
      caseCategory: '민사',
      summaryAdvice: '임대차 계약 만료 전(2~6개월 전) 임대인에게 계약 갱신 거절 및 반환 요구 의사를 내용증명이나 문자/녹취로 명확히 통보해 두어야 합니다. 보증금을 반환받지 못한 상태에서 이사를 가야 한다면 법원에 [임차권등기명령]을 신청하여 등기부에 기재된 것을 확인한 후 이사해야 대항력과 우선변제권이 유지됩니다.',
      keyIssues: ['동시이행항변권 및 명도의무', '임차권등기명령의 효력', '지연손해금 청구 가능 여부']
    };
  }

  if (text.includes('소음') || text.includes('층간소음') || text.includes('발소리') || text.includes('쿵쿵')) {
    return {
      searchKeyword: '층간소음',
      subKeywords: ['수인한도', '위자료', '공동주택관리법'],
      relatedStatutes: ['민법 제750조(불법행위책임)', '공동주택관리법 제20조', '공동주택 층간소음의 범위와 기준에 관한 규칙'],
      caseCategory: '민사',
      summaryAdvice: '층간소음으로 인한 손해배상을 청구하기 위해서는 국가 소음 기준(주간 39dB, 야간 34dB)을 지속적으로 초과했다는 객관적 소음 측정 기록, 112 신고 내역, 경비실 중재 요청 기록 등이 필수적입니다. 직접 찾아가 문을 두드리거나 고성을 지르는 행위는 오히려 주거침입이나 협박에 해당할 수 있으므로 관리주체 또는 환경분쟁조정위원회를 통해 중재를 신청하는 것이 안전합니다.',
      keyIssues: ['사회통념상 수인한도 초과 여부', '정신적 고통에 따른 위자료 입증', '사적제재에 따른 형사책임 주의']
    };
  }

  if (text.includes('사기') || text.includes('중고') || text.includes('먹튀') || text.includes('송금') || text.includes('계좌')) {
    return {
      searchKeyword: '사기',
      subKeywords: ['전자금융거래법', '착오송금', '부당이득'],
      relatedStatutes: ['형법 제347조(사기)', '민법 제741조(부당이득)', '전자금융거래법 제6조'],
      caseCategory: '형사 / 민사',
      summaryAdvice: '중고거래나 온라인 거래 사기를 당한 경우 대화 캡처본, 입금 내역서, 판매 게시글 링크를 확보하여 즉시 경찰서 사이버수사팀에 고소장을 접수하세요. 만약 착오로 잘못 송금한 경우라면 거래은행을 통해 수취인에게 반환 요청을 진행하고, 불응 시 예금보험공사의 [착오송금 반환지원제도]를 신청할 수 있습니다.',
      keyIssues: ['편취 범의 및 기망 행위 입증', '수취인의 부당이득반환의무', '사기 피해금 보전 및 배상명령신청']
    };
  }

  if (text.includes('월급') || text.includes('임금') || text.includes('퇴직금') || text.includes('주휴') || text.includes('알바') || text.includes('해고')) {
    return {
      searchKeyword: '임금',
      subKeywords: ['근로기준법', '주휴수당', '통상임금', '부당해고'],
      relatedStatutes: ['근로기준법 제36조(금품청산)', '근로기준법 제55조(휴일)', '근로자퇴직급여 보장법 제9조'],
      caseCategory: '노동 / 행정',
      summaryAdvice: '퇴사 후 14일 이내에 임금 및 퇴직금이 지급되지 않으면 고용노동부에 진정을 제기할 수 있습니다. 1주 소정근로시간이 15시간 이상이고 개근했다면 단기 아르바이트생이라도 주휴수당을 받을 권리가 법으로 보장됩니다. 출퇴근 기록, 급여명세서, 근로계약서, 문자 지시 내역을 증거로 수집해 두세요.',
      keyIssues: ['퇴직 후 14일 금품청산 의무 위반', '포괄임금제의 효력 여부', '지연이자(연 20%) 청구권']
    };
  }

  if (text.includes('교통사고') || text.includes('과실') || text.includes('비보호') || text.includes('접촉사고') || text.includes('추돌')) {
    return {
      searchKeyword: '교통사고',
      subKeywords: ['과실비율', '도로교통법', '손해배상'],
      relatedStatutes: ['도로교통법 제5조', '민법 제750조', '자동차손해배상 보장법 제3조'],
      caseCategory: '민사',
      summaryAdvice: '사고 즉시 블랙박스 영상 확보와 도로 현장 사진(타이어 방향, 차선 위치)을 원거리/근거리로 촬영하세요. 비보호 좌회전 사고나 신호 없는 교차로 사고의 경우 직진 차량의 과속 여부나 선진입 여부에 따라 기본 과실비율(80:20 등)에서 10~20% 상계 조정될 수 있습니다.',
      keyIssues: ['기본 과실비율 도표 적용 기준', '상대방 과속에 따른 과실 가산', '대인·대물 손해액 및 향후치료비']
    };
  }

  // 기본 반환
  return {
    searchKeyword: '손해배상',
    subKeywords: ['민법', '불법행위', '계약불이행'],
    relatedStatutes: ['민법 제750조(불법행위의 내용)', '민법 제390조(채무불이행과 손해배상)'],
    caseCategory: '민사',
    summaryAdvice: '법적 분쟁에서 승소하기 위해서는 상대방의 위법한 행위(또는 계약 위반), 발생한 실제 손해액, 그리고 둘 사이의 인과관계를 입증할 수 있는 객관적 증거(계약서, 문자/카카오톡, 녹취, 내용증명) 확보가 가장 중요합니다.',
    keyIssues: ['위법성 및 과실의 입증책임', '손해의 범위와 인과관계', '소멸시효 완성 여부']
  };
}

/**
 * 5. 북마크 API
 */
app.get('/api/bookmarks', (req, res) => {
  try {
    const data = fs.readFileSync(BOOKMARKS_FILE, 'utf8');
    res.json({ success: true, bookmarks: JSON.parse(data) });
  } catch (err) {
    res.json({ success: true, bookmarks: [] });
  }
});

app.post('/api/bookmarks', (req, res) => {
  try {
    const item = req.body;
    if (!item || !item.precSeq) {
      return res.status(400).json({ success: false, error: '판례 데이터가 올바르지 않습니다.' });
    }
    const current = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf8') || '[]');
    const exists = current.find(b => b.precSeq === item.precSeq);
    if (!exists) {
      current.unshift({
        ...item,
        savedAt: getKSTDateString()
      });
      fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(current, null, 2), 'utf8');
    }
    res.json({ success: true, bookmarks: current });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.delete('/api/bookmarks/:id', (req, res) => {
  try {
    const id = req.params.id;
    const current = JSON.parse(fs.readFileSync(BOOKMARKS_FILE, 'utf8') || '[]');
    const filtered = current.filter(b => b.precSeq !== id);
    fs.writeFileSync(BOOKMARKS_FILE, JSON.stringify(filtered, null, 2), 'utf8');
    res.json({ success: true, bookmarks: filtered });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// SPA 라우트 폴백
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`⚖️  LawFinder (AI 판례 검색 & 법률 Q&A 포털) 구동 중`);
  console.log(`🌐 포트: ${PORT}`);
  console.log(`⏰ KST 시간: ${getKSTDateString()}`);
  console.log(`🔑 법제처 OC 설정: ${LAW_OC ? '설정됨' : '미설정 (Mock Fallback 동작)'}`);
  console.log(`🤖 Gemini AI 설정: ${GEMINI_API_KEY ? '설정됨' : '미설정 (규칙 기반 NLP 동작)'}`);
  console.log(`=======================================================`);
});
