# Stage 1: Build frontend
FROM node:20-slim AS build-web
WORKDIR /web
COPY packages/web/package*.json ./
RUN npm install
COPY packages/web ./
ARG VITE_AUTH_URL=https://ai-assistant.freeddns.org/auth/login
RUN VITE_BASE_URL=/photos/ VITE_AUTH_URL=$VITE_AUTH_URL VITE_API_BASE=/photos/api npm run build

# Stage 2: Python deps (heaviest layer — cached unless requirements change)
FROM python:3.11-slim AS python-deps
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    cmake \
    libopenblas-dev \
    liblapack-dev \
    libx11-dev \
    libgtk-3-dev \
    && rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir \
    --extra-index-url https://download.pytorch.org/whl/cpu \
    torch torchvision \
    face_recognition \
    facenet-pytorch \
    pillow-heif \
    Pillow \
    numpy

# Pre-download facenet model weights (avoids runtime DNS failure in restricted envs)
RUN python3 -c "from facenet_pytorch import InceptionResnetV1; InceptionResnetV1(pretrained='vggface2').eval()"

# Stage 3: Final image — use python:3.11-slim as base (same GLIBC as python-deps)
FROM python:3.11-slim

# Install Node.js 20 + runtime libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    libopenblas0 \
    libgomp1 \
    libvips \
    && curl -fsSL https://deb.nodesource.com/setup_20.x | bash - \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/*

# Copy Python packages from python-deps stage
COPY --from=python-deps /usr/local/lib/python3.11 /usr/local/lib/python3.11
COPY --from=python-deps /usr/local/bin/python3.11 /usr/local/bin/python3.11
COPY --from=python-deps /root/.cache/torch /root/.cache/torch
RUN ln -sf /usr/local/bin/python3.11 /usr/local/bin/python3

WORKDIR /app

# Install Node deps
COPY packages/backend/package.json ./
RUN npm install --omit=dev && \
    npm rebuild sharp --update-binary || true

# Copy backend source (preserve node_modules installed above)
COPY packages/backend/src ./src

# Copy built frontend
COPY --from=build-web /web/dist ./web/dist

EXPOSE 8000

ENV NODE_ENV=production
ENV PORT=8000
ENV FRONTEND_DIST=/app/web/dist

CMD ["node", "src/server.js"]
