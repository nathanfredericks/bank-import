FROM oven/bun:1.3.3@sha256:fbf8e67e9d3b806c86be7a2f2e9bae801f2d9212a21db4dcf8cc9889f5a3c9c4 AS bun
FROM mcr.microsoft.com/playwright:v1.59.1-noble@sha256:040190be07ce081a025d95f2aeab57b588bed4f19165c1c93cb765372d368463 AS base
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
ENV CLOAKBROWSER_CACHE_DIR=/opt/cloakbrowser \
    CLOAKBROWSER_AUTO_UPDATE=false
WORKDIR /usr/src/app

FROM base AS dependencies
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
RUN bun -e 'import { ensureBinary } from "cloakbrowser"; await ensureBinary()'

FROM base AS release
COPY --from=dependencies /usr/src/app/node_modules ./node_modules
COPY --from=dependencies /opt/cloakbrowser /opt/cloakbrowser
COPY package.json bun.lock tsconfig.json ./
COPY src ./src
RUN mkdir -p traces && chown -R pwuser:pwuser /usr/src/app /opt/cloakbrowser
USER pwuser
ENTRYPOINT ["timeout", "--signal=TERM", "--kill-after=119s", "300s", "xvfb-run", "-a", "bun"]
CMD ["run", "src/index.ts"]
