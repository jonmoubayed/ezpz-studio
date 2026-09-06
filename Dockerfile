FROM --platform=$BUILDPLATFORM node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5 AS frontend
WORKDIR /build
COPY package.json package-lock.json ./
COPY scripts/copy-vendor.mjs scripts/copy-vendor.mjs
RUN npm ci
COPY tsconfig.json vite.config.ts index.html components.json ./
COPY src ./src
COPY public ./public
RUN npm run build

FROM python:3.12-slim-bookworm@sha256:782412e85d0f0984994c290652577d4018aff08145c85b262bb63dc0c7522254 AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 studio && useradd --uid 10001 --gid studio --create-home studio \
    && mkdir -p /app /data && chown studio:studio /data
WORKDIR /app
LABEL org.opencontainers.image.source="https://github.com/jonmoubayed/ezpz-studio" \
      org.opencontainers.image.licenses="MIT"
COPY requirements.lock ./
RUN pip install --no-cache-dir -r requirements.lock
COPY backend ./backend
COPY ezpz.py LICENSE EXTEND-LICENSE.md ./
COPY licenses ./licenses
COPY --from=frontend /build/dist ./static
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    EZPZ_DATABASE_URL=sqlite:////data/ezpz.db EZPZ_BLOB_ROOT=/data/blobs \
    EZPZ_STATIC_ROOT=/app/static EZPZ_SEED_DEMO=false
USER studio
VOLUME ["/data"]
EXPOSE 4173
HEALTHCHECK --interval=15s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4173/v1/ready', timeout=3)"
CMD ["python", "-m", "backend.server", "--root", "/data", "--host", "0.0.0.0", "--port", "4173"]
