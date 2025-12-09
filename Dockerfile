FROM mcr.microsoft.com/playwright:v1.56.0-noble AS base

RUN apt-get update
RUN apt-get install -y unzip

ENV BUN_INSTALL=/usr/local
RUN curl -fsSL https://bun.sh/install | bash

WORKDIR /usr/src/app

FROM base AS install
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

FROM base AS release
COPY --from=install /temp/prod/node_modules node_modules
COPY . .

ENTRYPOINT ["sh", "-c", "xvfb-run bun run src/index.ts"]