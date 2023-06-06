FROM node:18-alpine

COPY package.json package-lock.json ./
RUN npm ci

COPY . ./
RUN npm run build && npm prune --omit dev

CMD ["node", "dist/index.js"]
