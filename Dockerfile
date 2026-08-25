# The worker: Node plus a real Chromium, which is why this cannot run on Vercel.
#
# Playwright's own image already carries a matching browser and every shared
# library Chromium needs, so there is nothing to install beyond the app itself.
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src ./src

# The vault is mounted in rather than baked in, so the card never ends up in an
# image layer that could be pushed to a registry:
#   docker run -v /secure/vault.enc:/app/vault.enc:ro ...
VOLUME ["/app/runs"]

ENV NODE_ENV=production
ENV HEADLESS=true

CMD ["node", "src/index.js", "worker"]
