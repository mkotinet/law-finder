# ⚖️ LawFinder v2.1 (AI 판례 검색 & 눈높이 법률 Q&A 포털)

대한민국 법제처 국가법령정보 공동활용(`https://www.law.go.kr`, HTTPS/JSON) Open API와 **Google Gemini 2.5 Flash**를 결합한 **실시간 2단계 RAG & 중학생·고등학생·대학생/일반 3단계 눈높이 법률 해설 서비스**입니다.

👉 **운영 주소:** [https://law.danminlove.com](https://law.danminlove.com)

---

## 🌟 주요 기능 (v2.0.0)
1. **법제처 실시간 HTTPS/JSON 판례 검색**:
   - 대법원·고등법원·지방법원 필터, 판례명/본문 검색, 다중 페이지네이션 지원.
   - 국세법령정보시스템 등 API 전문 미제공 외부 연계 판례도 404 오류 없이 국가법령정보센터 공식 원문 링크로 즉시 연결.
2. **진짜 2단계 AI RAG 법률 Q&A**:
   - **1단계:** Gemini 2.5 Flash(`gemini-flash-latest` 자동 폴백)가 일상 언어에서 핵심 법률 키워드 추출.
   - **2단계:** 법제처 실시간 대법원 판례 조회 및 상위 판례 판시사항·요지 병렬 수집.
   - **3단계:** 실제 조회된 판례 번호·요지에 근거한 맞춤형 대응 조언 및 인용 판례 생성 (`analysisSource` 투명 표기).
3. **엔터프라이즈급 보안 및 성능 최적화**:
   - 엄격 CSP(`script-src 'self'`, 인라인 이벤트 핸들러 0개), OWASP 보안 헤더, `x-powered-by` 제거.
   - Sliding-Window Rate Limiting(일반 90/분, AI 10/분), 64KB 요청 제한, `x-goog-api-key` 헤더 인증.
   - 유계 LRU + TTL + 동시 요청 병합 캐시(`lib/cache.js`) 및 기기별 UUID v4 격리 북마크(`lib/security.js`).
   - `npm audit` 취약점 **0건**.
4. **모바일/PC 듀얼 최적화 & PWA 표준**:
   - 상단바 접기(`Alt+H`) + 1행 요약바, 모바일 상세 필터 자동 접힘, `90dvh` Zero-Cut 바텀시트 & 스티키 푸터.
   - PNG 아이콘(180/192/512px), 원클릭 설치 배너 및 브라우저별 설치 가이드, 실시간 버전 자동 갱신 & What's New 보고창.

---

## 🚀 테스트 및 실행

```bash
# 로컬 테스트 (문법 검사 + 단위/통합 테스트)
npm test

# 서버 실행
PORT=8080 LAW_OC=your_oc GEMINI_API_KEY=your_key npm start
```

### 시놀로지 DS1019+ Portainer 환경변수
| 환경변수명 | 기본값 | 설명 |
| :--- | :--- | :--- |
| `LAW_OC` | - | 국가법령정보 공동활용(open.law.go.kr) 인증값(ID) |
| `GEMINI_API_KEY` | - | Google AI Studio API Key |
| `GEMINI_MODEL` | `gemini-2.5-flash` | 주 Gemini 모델명 (장애 시 `gemini-flash-latest` 자동 폴백) |
| `NODE_OPTIONS` | `--max-old-space-size=192` | 시놀로지 NAS 메모리 상한 보호 (`mem_limit: 256m`) |

---

## 📄 기술 문서
* [기술레포트.md](./기술레포트.md): v2.0.0 아키텍처, 보안 및 REST API 상세 명세서
* [트러블슈팅.md](./트러블슈팅.md): 6대 핵심 RCA, 해결 패턴 및 재발 방지 체크리스트
* [히스토리.md](./히스토리.md): 단계별 개발·배포 타임라인
