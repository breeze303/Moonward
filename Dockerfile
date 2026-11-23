FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY index.html tsconfig.json ./
COPY public ./public
COPY src ./src
COPY shared ./shared
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8090
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
COPY src/services/api/sse.ts ./src/services/api/sse.ts
COPY LICENSE ./
USER node
EXPOSE 8090
CMD ["node", "server/postgres/main.ts"]
