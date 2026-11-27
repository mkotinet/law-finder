# ⚖️ LawFinder (AI 판례 검색 & 법률 Q&A 포털)

대한민국 법제처 국가법령정보 공동활용(open.law.go.kr) Open API와 Google Gemini AI를 결합한 **차세대 지능형 판례 검색 및 법률 질의응답 서비스**입니다.

---

## 🌟 주요 기능
1. **공공 판례 통합 검색**:
   - 대법원 및 하급심 판례 실시간 검색 (판례명, 본문, 사건번호)
   - 선고일자 최신순 정렬 및 법원/사건유형별 뱃지 제공
2. **AI 하이브리드 법률 Q&A (RAG)**:
   - 일상 대화체 질문 입력 시 AI가 핵심 법률 쟁점, 적용 법조문, 행동 요령을 알기 쉽게 3줄 요약
   - 관련 판례를 자동으로 추천하여 연계 제공
3. **판례 상세 & 조문 뷰어**:
   - 판시사항, 판결요지, 참조조문, 판례 전문 탭 분리 뷰어
   - 모바일 바텀시트 / PC 모달 반응형 인터페이스
   - 판례 내용 복사 및 북마크(보관함) 저장
4. **스마트 Fallback 모드**:
   - 외부 API 키가 없거나 공공 서버 장애 시에도 10대 민생 법률 고품질 판례 데이터셋으로 100% 정상 구동
5. **PWA & 모바일 최적화**:
   - 모바일 홈 화면 추가 시 독립형 앱(Standalone) 구동
   - BFCache 대응 및 오프라인 서비스 워커 캐싱

---

## 🚀 시놀로지 DS1019+ Portainer 배포 가이드

### 1. Portainer 스택 생성
* **Stack Name:** `law-finder`
* **Port:** `8095:80`
* **Network:** `npm_default`
* **Volume:** `lawfinder_data:/app/data`

### 2. 환경변수 설정
| 환경변수명 | 필수 여부 | 설명 |
| :--- | :--- | :--- |
| `LAW_OC` | 선택 (권장) | 국가법령정보 공동활용(open.law.go.kr) 발급 인증값(ID) |
| `GEMINI_API_KEY` | 선택 (권장) | Google AI Studio(aistudio.google.com) 발급 API Key |
| `PORT` | 기본값 `80` | 내부 컨테이너 포트 |

### 3. Nginx Proxy Manager (NPM) 리버스 프록시 연동
1. **Domain Names:** `law.danminlove.com`
2. **Forward Hostname / IP:** `192.168.0.96` (또는 컨테이너명 `law-finder`)
3. **Forward Port:** `8095` (컨테이너 직접 지정 시 `80`)
4. **옵션:** `Block Exploits`, `Websockets Support` 활성화
5. **SSL:** Let's Encrypt 공인 인증서 적용 (`Force SSL`, `HTTP/2 Support`)

---

## 📄 기술 문서
* [기술레포트.md](./기술레포트.md): 시스템 아키텍처 및 REST API 상세 명세서
* [트러블슈팅.md](./트러블슈팅.md): 공공 API CORS, XML 파싱, 장애 극복 패턴
* [히스토리.md](./히스토리.md): 개발 단계별 작업 타임라인
