FROM mcr.microsoft.com/playwright:v1.47.2-noble

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm install

COPY . .

RUN npm run build

CMD ["sh", "-c", "xvfb-run node dist/index.js"]