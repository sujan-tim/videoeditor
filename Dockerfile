# One image: the static dashboard + the FastAPI backend + FFmpeg.
FROM node:22-slim AS web
WORKDIR /web
COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci
COPY frontend/ ./
RUN rm -f .env.local && npm run build

FROM python:3.12-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app/backend
COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY backend/ ./
COPY --from=web /web/out /app/frontend/out

# Hugging Face Spaces runs the container as uid 1000, so the data folder must be writable by it.
RUN mkdir -p /data && chmod 777 /data && chmod -R a+rX /app

ENV VIDEO_EDITOR_DATA_DIR=/data \
    FRONTEND_DIR=/app/frontend/out \
    HF_HOME=/data/models \
    WHISPER_MODEL=base \
    PYTHONUNBUFFERED=1
EXPOSE 8000
CMD ["sh", "-c", "uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
