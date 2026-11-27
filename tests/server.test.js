const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createApp,
  formatJudgDate,
  cleanLawText,
  buildExternalLawUrl,
  parseJsonSafely
} = require('../server');
const { LRUCache } = require('../lib/cache');
const { isValidPrecId, parseClientId, sanitizeBookmarkItem } = require('../lib/security');

async function startTestServer(options = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'law-finder-test-'));
  const app = createApp({
    dataDir: tmpDir,
    disableDiskCache: true,
    ...options
  });
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const port = server.address().port;
  const baseUrl = `http://127.0.0.1:${port}`;
  return {
    baseUrl,
    close: async () => {
      await new Promise((resolve) => server.close(resolve));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  };
}

test('유틸리티 단위 테스트: formatJudgDate, cleanLawText, parseJsonSafely, buildExternalLawUrl', () => {
  assert.equal(formatJudgDate('20260529'), '2026.05.29');
  assert.equal(formatJudgDate('2026.06.12.'), '2026.06.12');

  assert.equal(
    cleanLawText('<p>제1조 &lt;개정&gt;</p><br/>&nbsp;내용 &quot;인용&quot;'),
    '제1조 <개정>\n\n내용 "인용"'
  );

  assert.deepEqual(parseJsonSafely('```json\n{"searchKeyword":"전세"}\n```'), {
    searchKeyword: '전세'
  });

  assert.match(
    buildExternalLawUrl({ precSeq: '622247', caseNumber: '2026다200365', dataSource: '대법원' }),
    /^https:\/\/www\.law\.go\.kr\/LSW\/precInfoP\.do\?precSeq=622247/
  );
  assert.match(
    buildExternalLawUrl({ precSeq: '622141', caseNumber: '서울행정법원-2025-구합-51124', dataSource: '국세법령정보시스템' }),
    /^https:\/\/www\.law\.go\.kr\/precSc\.do\?/
  );

  assert.equal(isValidPrecId('622247'), true);
  assert.equal(isValidPrecId('../etc/passwd'), false);
  assert.equal(parseClientId('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(parseClientId('not-a-uuid'), null);

  const sanitized = sanitizeBookmarkItem({
    precSeq: '622247',
    caseName: '임대차보증금',
    externalUrl: 'javascript:alert(1)',
    maliciousExtra: 'should-be-stripped'
  });
  assert.equal(sanitized.precSeq, '622247');
  assert.equal(sanitized.externalUrl, '');
  assert.equal('maliciousExtra' in sanitized, false);
});

test('LRUCache: 최대 용량 축출(Eviction), TTL 만료 및 동시 요청 병합(Coalescing)', async () => {
  const cache = new LRUCache({ maxSize: 2, defaultTTLMs: 50 });
  cache.set('a', 1);
  cache.set('b', 2);
  assert.equal(cache.get('a'), 1); // 'a' 최근 사용으로 갱신 -> 'b'가 가장 오래됨
  cache.set('c', 3);
  assert.equal(cache.size, 2);
  assert.equal(cache.get('b'), undefined);
  assert.equal(cache.get('a'), 1);
  assert.equal(cache.get('c'), 3);

  // TTL 만료 확인
  await new Promise((r) => setTimeout(r, 65));
  assert.equal(cache.get('a'), undefined);

  // 동시 캐시 미스 병합 (Stampede 방지)
  let calls = 0;
  const factory = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 25));
    return { ok: true };
  };
  const [r1, r2, r3] = await Promise.all([
    cache.getOrSet('hot-key', factory, 1000),
    cache.getOrSet('hot-key', factory, 1000),
    cache.getOrSet('hot-key', factory, 1000)
  ]);
  assert.equal(calls, 1);
  assert.deepEqual(r1.value, { ok: true });
  assert.deepEqual(r2.value, { ok: true });
  assert.deepEqual(r3.value, { ok: true });
});

test('보안 헤더, PWA 무캐시 헤더, 입력 검증 및 Rate Limiting 통합 테스트', async () => {
  const srv = await startTestServer({
    lawOc: '',
    geminiApiKey: '',
    rateLimitConfig: { generalMax: 50, aiMax: 2 }
  });

  try {
    // 1. 보안 헤더 & x-powered-by 제거
    const healthRes = await fetch(`${srv.baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    assert.equal(healthRes.headers.get('x-powered-by'), null);
    assert.equal(healthRes.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(healthRes.headers.get('x-frame-options'), 'DENY');
    const csp = healthRes.headers.get('content-security-policy');
    assert.ok(csp.includes("script-src 'self'"));
    assert.ok(!csp.includes("script-src 'self' 'unsafe-inline'"));

    // 2. PWA & 버전 무캐시 헤더 검증
    const verRes = await fetch(`${srv.baseUrl}/api/version`);
    assert.equal(verRes.status, 200);
    assert.match(verRes.headers.get('cache-control'), /no-store/);
    const verJson = await verRes.json();
    assert.equal(verJson.version, '2.1.0');

    const swRes = await fetch(`${srv.baseUrl}/sw.js`);
    assert.equal(swRes.status, 200);
    assert.equal(swRes.headers.get('service-worker-allowed'), '/');
    assert.match(swRes.headers.get('cache-control'), /no-store/);

    // 3. 입력값 검증
    const badIdRes = await fetch(`${srv.baseUrl}/api/prec/detail?id=abc<script>`);
    assert.equal(badIdRes.status, 400);

    const longQueryRes = await fetch(`${srv.baseUrl}/api/prec/search?query=${'가'.repeat(201)}`);
    assert.equal(longQueryRes.status, 400);

    const shortAskRes = await fetch(`${srv.baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '가' })
    });
    assert.equal(shortAskRes.status, 400);

    // 4. AI 엔드포인트 Rate Limiting (aiMax = 2 -> 3번째 요청 429)
    const ask1 = await fetch(`${srv.baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '전세 보증금 반환 문의' })
    });
    assert.equal(ask1.status, 200);
    const ask2 = await fetch(`${srv.baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '층간소음 위자료 기준' })
    });
    assert.equal(ask2.status, 200);
    const ask3 = await fetch(`${srv.baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '세 번째 과도한 요청' })
    });
    assert.equal(ask3.status, 429);
    assert.ok(Number(ask3.headers.get('retry-after')) >= 1);
  } finally {
    await srv.close();
  }
});

test('법제처 HTTPS/JSON 연동, 외부 연계 판례(622141) 404 방지, Gemini 2단계 RAG & 폴백 테스트', async () => {
  const seenRequests = [];

  const mockFetch = async (url, init = {}) => {
    seenRequests.push({ url: String(url), headers: init.headers || {} });

    // 1. 법제처 목록 검색
    if (String(url).startsWith('https://www.law.go.kr/DRF/lawSearch.do')) {
      return new Response(
        JSON.stringify({
          PrecSearch: {
            totalCnt: '2',
            prec: [
              {
                판례일련번호: '622247',
                사건명: '전세보증금반환보증 지연손해금 사건',
                사건번호: '2026다200365',
                선고일자: '2026.05.29',
                법원명: '대법원',
                사건종류명: '민사',
                판결유형: '판결',
                데이터출처명: '대법원'
              },
              {
                판례일련번호: '622141',
                사건명: '국세 전세금 현금증여 취소 사건',
                사건번호: '서울행정법원-2025-구합-51124',
                선고일자: '2026.06.12',
                법원명: '',
                사건종류명: '일반행정',
                판결유형: '',
                데이터출처명: '국세법령정보시스템'
              }
            ]
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 2. 법제처 상세 조회
    if (String(url).includes('ID=622247')) {
      return new Response(
        JSON.stringify({
          PrecService: {
            판례정보일련번호: '622247',
            사건명: '전세보증금반환보증 지연손해금 사건',
            사건번호: '2026다200365',
            선고일자: '20260529',
            법원명: '대법원',
            사건종류명: '민사',
            판결유형: '판결',
            판시사항: '[1] 보증채무 이행 지연손해금 기준',
            판결요지: '보증회사는 약정 기한 경과 시 지연손해금을 지급할 의무가 있다.',
            참조조문: '주택임대차보호법 제3조, 민법 제397조',
            판례내용: '전문 본문 테스트'
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    if (String(url).includes('ID=622141')) {
      return new Response(
        JSON.stringify({ Law: '일치하는 판례가 없습니다. 판례명을 확인하여 주십시오.' }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // 3. Gemini 1차 모델 404 -> 2차 폴백 모델 성공 시뮬레이션
    if (String(url).includes('/gemini-2.5-flash:generateContent')) {
      return new Response(JSON.stringify({ error: { code: 404, message: 'not found' } }), { status: 404 });
    }
    if (String(url).includes('/gemini-flash-latest:generateContent')) {
      const bodyObj = JSON.parse(init.body);
      const userPrompt = bodyObj.contents[0].parts[0].text;
      // 1단계 키워드 추출 vs 3단계 RAG 합성 구분
      if (userPrompt.includes('<retrieved_precedents>')) {
        return new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        relatedStatutes: ['주택임대차보호법 제3조', '민법 제397조'],
                        summaryAdvice: '대법원 2026다200365 판결에 따르면 보증채무 이행 지체 시 지연손해금 청구가 가능합니다.',
                        keyIssues: ['임대차보증금 반환 의무', '지연손해금 기산일'],
                        citedCases: [{ caseNumber: '2026다200365', relevance: '전세보증금 지연손해금 인정 판례' }]
                      })
                    }
                  ]
                }
              }
            ]
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      searchKeyword: '전세보증금',
                      subKeywords: ['임대차보증금', '지연손해금'],
                      caseCategory: '민사',
                      initialStatutes: ['주택임대차보호법 제3조']
                    })
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not Found', { status: 404 });
  };

  const srv = await startTestServer({
    lawOc: 'testoc',
    geminiApiKey: 'AIzaTestFakeKey12345',
    fetchImpl: mockFetch
  });

  try {
    // 1) 검색 API HTTPS + JSON 검증
    const searchRes = await fetch(`${srv.baseUrl}/api/prec/search?query=전세&court=대법원`);
    assert.equal(searchRes.status, 200);
    const searchData = await searchRes.json();
    assert.equal(searchData.isMock, false);
    assert.equal(searchData.items.length, 2);
    assert.equal(searchData.items[1].courtName, '국세법령정보시스템');

    const lawSearchReq = seenRequests.find((r) => r.url.includes('lawSearch.do'));
    assert.ok(lawSearchReq.url.startsWith('https://www.law.go.kr/DRF/lawSearch.do'));
    assert.ok(lawSearchReq.url.includes('type=JSON'));
    assert.ok(lawSearchReq.url.includes('datSrcNm='));

    // 2) 대법원 상세(622247): 날짜 포맷 정규화 확인
    const detailOkRes = await fetch(`${srv.baseUrl}/api/prec/detail?id=622247`);
    assert.equal(detailOkRes.status, 200);
    const detailOk = await detailOkRes.json();
    assert.equal(detailOk.isExternalOnly, false);
    assert.equal(detailOk.data.judgDate, '2026.05.29');

    // 3) 국세법령정보시스템 상세(622141): 404 대신 200 + isExternalOnly + 원문 링크 반환
    const detailExtRes = await fetch(`${srv.baseUrl}/api/prec/detail?id=622141`);
    assert.equal(detailExtRes.status, 200);
    const detailExt = await detailExtRes.json();
    assert.equal(detailExt.isExternalOnly, true);
    assert.equal(detailExt.data.caseNumber, '서울행정법원-2025-구합-51124');
    assert.match(detailExt.data.externalUrl, /^https:\/\/www\.law\.go\.kr\/precSc\.do/);

    // 4) 2단계 AI RAG 검증 (모델 폴백 + x-goog-api-key 헤더 인증 + 실시간 판례 결합)
    const askRes = await fetch(`${srv.baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '전세보증금을 늦게 돌려주면 지연이자 받을 수 있나요?' })
    });
    assert.equal(askRes.status, 200);
    const askData = await askRes.json();
    assert.equal(askData.analysisSource, 'gemini');
    assert.equal(askData.analysisModel, 'gemini-flash-latest');
    assert.equal(askData.isMockPrecedents, false);
    assert.equal(askData.matchedPrecedents[0].caseNumber, '2026다200365');
    assert.equal(askData.aiAnalysis.citedCases[0].caseNumber, '2026다200365');

    // API 키가 URL이 아닌 x-goog-api-key 헤더로만 전달되었는지 검증
    const geminiReqs = seenRequests.filter((r) => r.url.includes('generativelanguage.googleapis.com'));
    assert.ok(geminiReqs.length >= 2);
    for (const gReq of geminiReqs) {
      assert.ok(!gReq.url.includes('AIzaTestFakeKey'), 'API key must NOT be in URL');
      assert.equal(gReq.headers['x-goog-api-key'], 'AIzaTestFakeKey12345');
    }
  } finally {
    await srv.close();
  }
});

test('북마크 클라이언트별 UUID 격리 및 화이트리스트 저장 테스트', async () => {
  const srv = await startTestServer({ lawOc: '', geminiApiKey: '' });
  const clientA = '11111111-1111-4111-8111-111111111111';
  const clientB = '22222222-2222-4222-8222-222222222222';

  try {
    // 헤더 누락 -> 400
    const noId = await fetch(`${srv.baseUrl}/api/bookmarks`);
    assert.equal(noId.status, 400);

    // Client A 북마크 저장
    const addRes = await fetch(`${srv.baseUrl}/api/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Client-Id': clientA },
      body: JSON.stringify({
        precSeq: '622247',
        caseName: '임대차보증금 사건',
        injected: 'evil'
      })
    });
    assert.equal(addRes.status, 200);
    const added = await addRes.json();
    assert.equal(added.bookmarks.length, 1);
    assert.equal('injected' in added.bookmarks[0], false);

    // Client B에게는 보이지 않아야 함
    const listB = await (await fetch(`${srv.baseUrl}/api/bookmarks`, { headers: { 'X-Client-Id': clientB } })).json();
    assert.equal(listB.bookmarks.length, 0);

    // Client B가 삭제 시도해도 Client A 데이터는 유지되어야 함
    await fetch(`${srv.baseUrl}/api/bookmarks/622247`, {
      method: 'DELETE',
      headers: { 'X-Client-Id': clientB }
    });
    const listA = await (await fetch(`${srv.baseUrl}/api/bookmarks`, { headers: { 'X-Client-Id': clientA } })).json();
    assert.equal(listA.bookmarks.length, 1);
  } finally {
    await srv.close();
  }
});


test('v2.1.0 눈높이 3단계 판례 해설(/api/prec/explain): 정상 생성, 캐시 히트 Rate Limit 미차감, 외부연계·폴백 검증', async () => {
  let geminiCalls = 0;

  const mockFetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith('https://www.law.go.kr/DRF/lawSearch.do')) {
      return new Response(
        JSON.stringify({
          PrecSearch: {
            totalCnt: '1',
            prec: [
              {
                판례일련번호: '622141',
                사건명: '배우자가 지배하는 법인의 가수금 반제로 전세금을 현금증여 받았다고 보기 어렵다',
                사건번호: '서울행정법원-2025-구합-51124',
                선고일자: '2026.06.12',
                법원명: '',
                사건종류명: '일반행정',
                데이터출처명: '국세법령정보시스템'
              }
            ]
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.includes('ID=622247')) {
      return new Response(
        JSON.stringify({
          PrecService: {
            판례정보일련번호: '622247',
            사건명: '전세보증금반환보증 지연손해금 사건',
            사건번호: '2026다200365',
            선고일자: '20260529',
            법원명: '대법원',
            사건종류명: '민사',
            판결유형: '판결',
            판시사항: '[1] 보증채무 이행 지연 시 지연손해금 인정 여부(적극)',
            판결요지: '보증기관이 정당한 사유 없이 보증금 지급을 늦추면 지연손해금을 지급해야 한다.',
            참조조문: '민법 제397조, 주택임대차보호법 제3조'
          }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    if (u.includes('ID=622141')) {
      return new Response(JSON.stringify({ Law: '일치하는 판례가 없습니다.' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    if (u.includes('generativelanguage.googleapis.com')) {
      geminiCalls++;
      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      oneLineVerdict: '보증금을 늦게 돌려주면 늦어진 기간만큼 이자(지연손해금)를 더 줘야 합니다.',
                      glossary: [
                        { term: '적극', meaning: '법원이 맞다·인정된다고 판단했다는 뜻이에요.' },
                        { term: '지연손해금', meaning: '약속 날짜보다 늦게 갚을 때 추가로 내는 이자예요.' }
                      ],
                      levels: {
                        middle: {
                          title: '🌱 늦게 갚으면 추가 이자를 내야 해요',
                          explanation: '보증금을 돌려주기로 약속한 날이 지났는데 안 주면 늦어진 만큼 이자를 더 줘야 해요.',
                          example: '친구가 다음 주까지 갚기로 한 용돈을 한 달 늦게 준다면 미안한 만큼 보상을 해주는 것과 같아요.'
                        },
                        high: {
                          title: '📘 보증채무 이행지체와 지연손해금',
                          explanation: '보증기관이 약정 기한을 넘겨 보증금을 지급하면 지연손해금(법정 지연이자)을 부담해야 합니다.',
                          example: '알바 임금을 정해진 날에 못 받았을 때 지연이자를 청구할 수 있는 원리와 같습니다.'
                        },
                        general: {
                          title: '🎓 전세보증금 반환보증 지연손해금 청구 기준',
                          explanation: '주택도시보증공사 등 보증기관도 보증금 지급 기한을 넘길 경우 민법상 지연손해금 지급 의무가 인정됩니다.',
                          example: '전세보증보험 이행청구 후 정당한 사유 없이 지급이 지연되면 지연이자를 함께 청구할 수 있습니다.'
                        }
                      }
                    })
                  }
                ]
              }
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    }
    return new Response('Not Found', { status: 404 });
  };

  // aiMax: 1 로 설정해 캐시 히트가 Rate Limit을 차감하지 않는지 엄격히 검증
  const srv = await startTestServer({
    lawOc: 'testoc',
    geminiApiKey: 'AIzaTestFakeKey99999',
    fetchImpl: mockFetch,
    rateLimitConfig: { generalMax: 50, aiMax: 1 }
  });

  try {
    // 1. 잘못된 ID -> 400
    const badRes = await fetch(`${srv.baseUrl}/api/prec/explain?id=drop_table`);
    assert.equal(badRes.status, 400);

    // 2. 최초 요청(캐시 미스) -> 200, Gemini 1회 호출로 3단계 일괄 생성
    const firstRes = await fetch(`${srv.baseUrl}/api/prec/explain?id=622247`);
    assert.equal(firstRes.status, 200);
    const first = await firstRes.json();
    assert.equal(first.analysisSource, 'gemini');
    assert.equal(first.fromCache, false);
    assert.ok(first.data.levels.middle.example.length > 5);
    assert.ok(first.data.levels.high.explanation.length > 5);
    assert.ok(first.data.levels.general.explanation.length > 5);
    assert.equal(geminiCalls, 1);

    // 3. 동일 ID 3회 연속 재호출 -> 캐시 히트, Rate Limit(aiMax=1) 미차감, 모두 200 OK
    for (let i = 0; i < 3; i++) {
      const hitRes = await fetch(`${srv.baseUrl}/api/prec/explain?id=622247`);
      assert.equal(hitRes.status, 200);
      const hitJson = await hitRes.json();
      assert.equal(hitJson.fromCache, true);
    }
    assert.equal(geminiCalls, 1);

    // 4. 새로운 ID(캐시 미스)는 aiMax=1 초과로 429 차단되어야 함
    await fetch(`${srv.baseUrl}/api/prec/search?query=전세`);
    const secondNewRes = await fetch(`${srv.baseUrl}/api/prec/explain?id=622141`);
    assert.equal(secondNewRes.status, 429);
  } finally {
    await srv.close();
  }

  // 5. Gemini 미설정/장애 시 26종 내장 용어사전 규칙 폴백 + 외부 연계 판례(622141) 및 /api/ask level 검증
  const fallbackSrv = await startTestServer({
    lawOc: 'testoc',
    geminiApiKey: '',
    fetchImpl: mockFetch,
    rateLimitConfig: { generalMax: 50, aiMax: 10 }
  });
  try {
    await fetch(`${fallbackSrv.baseUrl}/api/prec/search?query=전세`);
    const extExplainRes = await fetch(`${fallbackSrv.baseUrl}/api/prec/explain?id=622141`);
    assert.equal(extExplainRes.status, 200);
    const extExplain = await extExplainRes.json();
    assert.equal(extExplain.analysisSource, 'rule-fallback');
    assert.equal(extExplain.isExternalOnly, true);
    assert.ok(extExplain.data.levels.middle.explanation.length > 10);
    assert.ok(extExplain.data.glossary.length >= 1);

    // /api/ask level별 응답 검증 (middle vs high)
    const askMiddleRes = await fetch(`${fallbackSrv.baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '전세 보증금을 안 돌려줘요', level: 'middle' })
    });
    assert.equal(askMiddleRes.status, 200);
    const askMiddle = await askMiddleRes.json();
    assert.equal(askMiddle.level, 'middle');
    assert.equal(askMiddle.levelLabel, '중학생');
    assert.ok(askMiddle.aiAnalysis.easyExample.includes('민수네'));
    assert.ok(Array.isArray(askMiddle.aiAnalysis.glossary) && askMiddle.aiAnalysis.glossary.length >= 1);

    const askHighRes = await fetch(`${fallbackSrv.baseUrl}/api/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: '전세 보증금을 안 돌려줘요', level: 'high' })
    });
    assert.equal(askHighRes.status, 200);
    const askHigh = await askHighRes.json();
    assert.equal(askHigh.level, 'high');
    assert.equal(askHigh.fromCache, false); // middle과 캐시 키 분리 확인
    assert.ok(askHigh.aiAnalysis.easyExample.includes('자취방'));
  } finally {
    await fallbackSrv.close();
  }
});
