FROM node:20-slim

RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    python3-pip \
    && pip3 install --break-system-packages --upgrade pip \
    && pip3 install --break-system-packages \
        "torch==2.6.0+cpu" \
        "torchvision==0.21.0" \
        --index-url https://download.pytorch.org/whl/cpu \
    && pip3 install --break-system-packages Pillow numpy facenet-pytorch pillow-heif \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dépendances (cachées tant que package.json ne change pas)
COPY packages/backend/package.json packages/backend/package-lock.json ./
RUN npm install --omit=dev

# Sources
COPY packages/backend ./

EXPOSE 3000

CMD ["node", "src/server.js"]
