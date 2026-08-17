FROM node:22-alpine AS deps
WORKDIR /app
# better-sqlite3 собирается из исходников: в alpine готового биндинга нет.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

# CLI Claude в образе не нужен: ступень `claude` ходит на хост через
# `hostshim/claude-shim.mjs` — там CLI уже авторизован интерактивно. Так из
# образа уходят и лишние 300 МБ, и возня с запуском CLI под root.

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/package*.json ./

# База задач лежит в томе: рестарт и переезд на новый образ не должны терять
# незакрытые запросы — ровно для этого она и на диске, а не в памяти.
ENV DATABASE_PATH=/data/human4ai.sqlite
VOLUME ["/data"]

# Порт внутри контейнера фиксированный; наружу его пробрасывает деплой.
ENV PORT=3200
EXPOSE 3200
CMD ["node", "dist/index.js"]
