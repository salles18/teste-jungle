FROM oven/bun:1.3.1-alpine
WORKDIR /app
COPY package.json bun.lock ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
ENV NODE_ENV=production PORT=3000
EXPOSE 3000
USER bun
# migrations are run explicitly (bun run db:migrate), never implicitly at boot
CMD ["bun", "run", "src/main.ts"]
