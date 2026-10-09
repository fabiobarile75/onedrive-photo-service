# Stage 1: Build frontend
FROM node:20-slim AS build-web
WORKDIR /web
COPY packages/web/package*.json ./
RUN npm install
COPY packages/web ./
RUN VITE_BASE_URL=/photos/ npm run build

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

# Stage 3: Final image
FROM node:20-slim

# Install Python runtime + minimal libs
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 \
    python3-pip \
    libopenblas0 \
    libgomp1 \
    && rm -rf /var/lib/apt/lists/*

# Copy Python packages from python-deps stage
COPY --from=python-deps /usr/local/lib/python3.11 /usr/local/lib/python3.11
COPY --from=python-deps /usr/local/bin/python3.11 /usr/local/bin/python3.11
RUN ln -sf /usr/local/bin/python3.11 /usr/local/bin/python3

WORKDIR /app

# Install Node deps
COPY packages/backend/package*.json ./
RUN npm install --omit=dev

# Copy backend source
COPY packages/backend ./

# Copy built frontend
COPY --from=build-web /web/dist ./web/dist

EXPOSE 8000

ENV NODE_ENV=production
ENV PORT=8000
ENV FRONTEND_DIST=/app/web/dist

CMD ["node", "src/server.js"]
