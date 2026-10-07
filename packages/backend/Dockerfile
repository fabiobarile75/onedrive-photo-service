FROM node:20-slim

RUN apt-get update && apt-get install -y \
    build-essential \
    python3 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY packages/backend/package.json packages/backend/package-lock.json ./

RUN npm install --omit=dev

COPY packages/backend ./

EXPOSE 3000

CMD ["node", "src/server.js"]
