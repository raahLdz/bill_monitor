FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install
COPY . .
RUN yarn build

FROM node:20-alpine
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install --production
COPY --from=builder /app/dist ./dist
CMD ["node", "dist/main"]
