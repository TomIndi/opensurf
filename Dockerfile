# OpenSurf, played locally: builds the site and serves it with Vite's preview server, which also runs the map
# download (Google Drive) and KSF world-record proxies, so no relay is needed.
#   docker compose up -d --build     then open http://localhost:4173
FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build
EXPOSE 4173
CMD ["npx", "vite", "preview", "--host", "0.0.0.0", "--port", "4173", "--strictPort"]
