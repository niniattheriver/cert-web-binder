# 인증 근거자료 웹 바인더 — Docker 이미지 (설계서 §7: 2순위/선택 경로)
#
# Docker는 기본 배포 경로가 아니다(서버 OS 미상 + 비개발자 유지보수). 컨테이너를 선호하는
# 조직을 위한 참고용이다. 기본 경로는 systemd(packaging/qaevidence.service) / WinSW.
#
# 빌드:  docker build -f packaging/Dockerfile -t qaevidence .
#        (빌드 컨텍스트 = 저장소 루트. .dockerignore 로 data/·_로컬자료/ 제외 필수 — 실데이터 유입 금지)
# 실행:  docker run -d --name qaevidence -p 8080:8080 -v qaevidence-data:/app/data qaevidence
#        (data/ 는 명명 볼륨으로 분리 — 컨테이너 교체가 상태를 건드리지 않음)
# 내부망 전제: 런타임 인터넷/CDN 접근 없음. pdf.js cMaps/standard_fonts 는 이미지 안에 포함.

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production

# 의존성 먼저 (레이어 캐시). NODE_ENV=production 이면 npm ci 가 devDependency 를 생략하므로
# --include=dev 로 강제한다 — 웹 빌드(typescript·vite)와 런타임(tsx) 모두 devDependency 에 있다.
COPY package.json package-lock.json ./
COPY server/package.json server/package.json
COPY web/package.json web/package.json
RUN npm ci --include=dev

# 소스 복사 + 웹 빌드(cmaps/standard_fonts → web/dist/pdfjs)
COPY . .
RUN npm run build -w web

EXPOSE 8080
VOLUME ["/app/data"]

# 헬스체크(내부 API)
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--import", "tsx", "server/src/index.ts"]
