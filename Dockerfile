FROM oven/bun:1.3 AS build
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile
COPY . .
RUN bun run build

FROM oven/bun:1.3-slim
WORKDIR /app
# The server's own dependencies only: the MP3 decoder it analyses songs with.
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY --from=build /app/dist ./dist
COPY server ./server
COPY shared ./shared
ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/data
VOLUME /data
EXPOSE 8080
CMD ["bun", "server/index.ts"]
