FROM fabioparis75/onedrive-python-deps:latest

# Fix numpy/Pillow version conflicts introduced by mediapipe/opencv pulling numpy>=2
RUN pip3 install --break-system-packages "numpy<2" "Pillow>=10.2.0,<10.3.0"

WORKDIR /app

# Dépendances (cachées tant que package.json ne change pas)
COPY packages/backend/package.json packages/backend/package-lock.json ./
RUN npm install --omit=dev

# Sources
COPY packages/backend ./

EXPOSE 3000

CMD ["node", "src/server.js"]
