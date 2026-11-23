FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/mock/package.json apps/mock/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci
COPY apps/ apps/
RUN npm run build

FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
COPY apps/mock/package.json apps/mock/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm ci --omit=dev --workspace @auto-pay/mock && npm cache clean --force
COPY --from=build /app/apps/mock/dist/ apps/mock/dist/
COPY --from=build /app/apps/web/dist/ apps/web/dist/
USER node
EXPOSE 8787
CMD ["node", "apps/mock/dist/site-server.js", "--container"]
